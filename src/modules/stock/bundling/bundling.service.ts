import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import {
  BUNDLING_ENTITY_TYPE,
  Bundling,
  BundlingDocument,
  BundlingMode,
  type RecipeSnapshot,
} from './schemas/bundling.schema.js';
import { BundleRecipe, BundleRecipeDocument } from './schemas/bundle-recipe.schema.js';
import {
  AvailabilityQueryDto,
  BundlingQueryDto,
  CancelBundlingDto,
  ComposeBundlingDto,
  CreateBundlingDto,
  EditBundlingDto,
  PreviewBundlingDto,
  SetRecipeDto,
} from './dto/bundling.dto.js';
import { CostService, type CostRef } from '../costing/cost.service.js';
import { StockService, roundQty, stockLocationScope, type StockEntryInput } from '../stock.service.js';
import { StockBalance, StockBalanceDocument } from '../schemas/stock-balance.schema.js';
import { CostLayer, CostLayerDocument } from '../costing/schemas/cost-layer.schema.js';
import {
  PRODUCT_ENTITY_TYPE,
  Product,
  ProductDocument,
  ProductStatus,
  ProductType,
} from '../../product/products/schemas/product.schema.js';
import { ProductService } from '../../product/products/product.service.js';
import { ProductGroup, ProductGroupDocument } from '../../product/product-groups/schemas/product-group.schema.js';
import { ProductUsageRegistry } from '../../product/products/product-usage.registry.js';
import { Location, LocationDocument } from '../../location/schemas/location.schema.js';
import { CompanyService } from '../../company/company.service.js';
import { VoucherStatus } from '../../accounting/vouchers/schemas/voucher.schema.js';
import { withScope } from '../../accounting/vouchers/data-scope.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { escapeRegExp } from '../../sequence/code-sequence.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction, type AuditChange } from '../../audit/schemas/audit-log.schema.js';
import { CommentsService } from '../../comments/comments.service.js';
import { EntityAccessRegistry } from '../../comments/entity-access.registry.js';
import { Permission, hasPermission } from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { type UserSnapshot, toUserSnapshot, userRefOf } from '../../../common/schemas/user-snapshot.schema.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';
import { renderPdf } from '../../../common/pdf/pdf-renderer.js';
import { printLayout } from '../../../common/pdf/print-layout.js';
import { round2 } from '../../../common/utils/money.util.js';

type Viewer = AuthenticatedUser;

const SEQUENCE = { key: 'bundling', prefix: 'BND-', width: 4 };
/** Unbundles have their own number series. */
const SEQUENCE_UNBUNDLE = { key: 'unbundling', prefix: 'UBD-', width: 4 };
const LABEL = 'Bundling';

type RecipeLike = { version: number; extraCostPerUnit: number; components: { productId: Types.ObjectId; qty: number }[] };

interface ProductInfo {
  code: string;
  name: string;
  cost: number;
}

/**
 * Recipes and the bundle/unbundle voucher. Bundling posts stock entries only
 * (components out, bundle in, or the reverse) through StockService in one
 * transaction with its number and audit entry. No edit; cancel reverses
 * strictly. "own"-scoped users see and enter only their allowedLocationIds.
 */
/** Any stock product can be a bundle output; the legacy 'bundle' type is still read as one. */
const BUNDLE_OUTPUT_TYPES: readonly ProductType[] = [ProductType.STOCK, ProductType.BUNDLE];

@Injectable()
export class BundlingService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Bundling.name) private readonly model: Model<BundlingDocument>,
    @InjectModel(BundleRecipe.name) private readonly recipeModel: Model<BundleRecipeDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(ProductGroup.name) private readonly groupModel: Model<ProductGroupDocument>,
    private readonly productService: ProductService,
    @InjectModel(Location.name) private readonly locationModel: Model<LocationDocument>,
    @InjectModel(StockBalance.name) private readonly balanceModel: Model<StockBalanceDocument>,
    private readonly stockService: StockService,
    private readonly costService: CostService,
    @InjectModel(CostLayer.name) private readonly layerModel: Model<CostLayerDocument>,
    private readonly companyService: CompanyService,
    private readonly sequenceService: SequenceService,
    private readonly auditService: AuditService,
    private readonly commentsService: CommentsService,
    entityAccess: EntityAccessRegistry,
    productUsage: ProductUsageRegistry,
  ) {
    entityAccess.register(BUNDLING_ENTITY_TYPE, {
      exists: async (id, user) => Boolean(await this.model.exists(withScope({ _id: id }, scopeOf(user))).exec()),
      canRead: (user) => hasPermission(user, Permission.BUNDLING_READ),
    });
    productUsage.register('bundle recipes and bundlings', async (productId, session) => {
      const s = session ?? null;
      return Boolean(
        (await this.recipeModel
          .exists({ $or: [{ bundleProductId: productId }, { 'components.productId': productId }] })
          .session(s)
          .exec()) ||
          (await this.model
            .exists({ $or: [{ bundleProductId: productId }, { 'recipeSnapshot.components.productId': productId }] })
            .session(s)
            .exec()),
      );
    });
  }

  // ---- recipes ----

  async getRecipe(productId: string) {
    const product = await this.bundleProduct(productId);
    const recipe = await this.recipeModel.findOne({ bundleProductId: product._id }).lean().exec();
    if (!recipe) throw new NotFoundException(`${product.code} has no recipe`);
    const info = await this.productInfo(recipe.components.map((component) => component.productId));
    return {
      bundleProductId: product._id.toString(),
      version: recipe.version,
      extraCostPerUnit: recipe.extraCostPerUnit,
      components: recipe.components.map((component) => ({
        productId: component.productId.toString(),
        productCode: info.get(component.productId.toString())?.code ?? null,
        productName: info.get(component.productId.toString())?.name ?? null,
        qty: component.qty,
      })),
      updatedBy: userRefOf(recipe.updatedBy),
      updatedAt: recipe.updatedAt,
    };
  }

  /** Creates or replaces the recipe (version +1); audited on the product. Past bundlings keep their snapshot. */
  async setRecipe(productId: string, dto: SetRecipeDto, actor: Viewer) {
    const bundle = await this.bundleProduct(productId);
    const ids = dto.components.map((component) => component.productId);
    await this.assertParts(ids, productId, 'components');
    const components = dto.components.map((component) => ({
      productId: new Types.ObjectId(component.productId),
      qty: roundQty(component.qty),
    }));
    const extraCostPerUnit = round2(dto.extraCostPerUnit);

    await runInTransaction(this.connection, (session) =>
      this.writeRecipe(bundle, components, extraCostPerUnit, actor, session),
    );
    return this.getRecipe(productId);
  }

  /** Parts must be unique stock products and not the output itself. `field` names the request array for errors. */
  async assertParts(ids: string[], outputId: string, field: string, session?: ClientSession) {
    const dup = ids.findIndex((id, index) => ids.indexOf(id) !== index);
    if (dup >= 0) throw new BadRequestException({ message: 'A component is on more than one line', field: `${field}.${dup}.productId` });
    const self = ids.indexOf(outputId);
    if (self >= 0) throw new BadRequestException({ message: 'A bundle cannot contain itself', field: `${field}.${self}.productId` });
    const products = await this.productModel
      .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } })
      .select('code name type isBundle')
      .session(session ?? null)
      .lean()
      .exec();
    for (const [index, id] of ids.entries()) {
      const product = products.find((candidate) => candidate._id.toString() === id);
      if (!product) throw new NotFoundException({ message: `Product ${id} not found`, field: `${field}.${index}.productId` });
      if (product.isBundle) {
        throw new BadRequestException({
          message: `${product.code} (${product.name}) is a bundle: a bundle cannot be a part of another bundle`,
          field: `${field}.${index}.productId`,
        });
      }
      if (product.type !== ProductType.STOCK) {
        throw new BadRequestException({
          message: `${product.code} (${product.name}) is a ${product.type} product: components must be stock products`,
          field: `${field}.${index}.productId`,
        });
      }
    }
  }

  /** Writes recipe version +1 and its audit entry. `skipIfSame` returns null instead of rejecting an unchanged recipe. */
  async writeRecipe(
    bundle: { _id: Types.ObjectId; code: string },
    components: { productId: Types.ObjectId; qty: number }[],
    extraCostPerUnit: number,
    actor: Viewer,
    session: ClientSession,
    options: { correlationId?: string; skipIfSame?: boolean } = {},
  ): Promise<boolean> {
    const existing = await this.recipeModel.findOne({ bundleProductId: bundle._id }).session(session).lean().exec();
    const describe = (list: readonly { productId: Types.ObjectId; qty: number }[]) =>
      list
        .map((component) => `${component.productId.toString()}x${component.qty}`)
        .sort()
        .join(',');
    if (existing && existing.extraCostPerUnit === extraCostPerUnit && describe(existing.components) === describe(components)) {
      if (options.skipIfSame) return false;
      throw new BadRequestException('No changes to save');
    }
    const info = await this.productInfo(
      [...components.map((component) => component.productId), ...(existing?.components.map((c) => c.productId) ?? [])],
      session,
    );
    const text = (list: readonly { productId: Types.ObjectId; qty: number }[]) =>
      list
        .map((component) => `${info.get(component.productId.toString())?.name ?? component.productId} x ${component.qty}`)
        .join(', ');
    const changes: AuditChange[] = [
      { field: 'recipe', label: 'Recipe', from: existing ? text(existing.components) : null, to: text(components) },
    ];
    if ((existing?.extraCostPerUnit ?? 0) !== extraCostPerUnit) {
      changes.push({
        field: 'extraCostPerUnit',
        label: 'Extra cost per unit',
        from: existing?.extraCostPerUnit ?? null,
        to: extraCostPerUnit,
      });
    }
    await this.recipeModel
      .updateOne(
        { bundleProductId: bundle._id },
        {
          $set: {
            components,
            extraCostPerUnit,
            version: (existing?.version ?? 0) + 1,
            updatedBy: toUserSnapshot(actor),
            updatedAt: new Date(),
          },
          $setOnInsert: { bundleProductId: bundle._id },
        },
        { upsert: true, session },
      )
      .exec();
    await this.auditService.record(
      {
        entityType: PRODUCT_ENTITY_TYPE,
        entityId: bundle._id,
        entityRef: bundle.code,
        action: AuditAction.UPDATED,
        actor,
        changes,
        correlationId: options.correlationId,
      },
      session,
    );
    return true;
  }

  /** Per component: needed per unit and in total, on hand at the location, short; and how many bundles can be made. */
  async availability(productId: string, query: AvailabilityQueryDto, viewer: Viewer) {
    assertLocationAllowed(viewer, query.locationId, 'see stock at');
    if (!Types.ObjectId.isValid(productId)) throw new BadRequestException(`Product id "${productId}" is not a valid id`);
    const recipe = await this.recipeOf(new Types.ObjectId(productId));
    return this.availabilityOf(recipe.components, query.locationId, query.qty ?? 1);
  }

  // ---- workspace: product + recipe + bundling in one transaction ----

  /**
   * One request, one transaction: create the product (if new), save the recipe
   * (if asked or new), post the bundling (if qty > 0). Any failure rolls back
   * all of it. The audit entries of the three steps share one correlationId.
   */
  async compose(dto: ComposeBundlingDto, actor: Viewer) {
    assertNotFuture(dto.date);
    assertLocationAllowed(actor, dto.locationId, 'bundle at');
    const isNew = Boolean(dto.product.new);
    if (isNew === Boolean(dto.product.id)) throw fieldError('Send either product.id or product.new', 'product');
    const bundle = dto.mode === BundlingMode.BUNDLE;
    if (!bundle && (isNew || dto.parts)) {
      throw fieldError("Unbundle uses the product's saved recipe: send product.id only", 'product');
    }
    if (!bundle && dto.qty <= 0) throw fieldError('qty must be at least 1 to unbundle', 'qty');
    if (!bundle && dto.extraCosts?.length) throw fieldError('Extra costs apply to bundling only', 'extraCosts');
    const saveRecipe = bundle && Boolean(dto.saveRecipe || isNew);
    if (dto.qty === 0 && !saveRecipe && !isNew) throw fieldError('Nothing to do: set qty or saveRecipe', 'qty');
    const need = (permission: Permission, what: string, field: string) => {
      if (!hasPermission(actor, permission)) {
        throw new ForbiddenException({ message: `You need the ${permission} permission to ${what}`, field });
      }
    };
    if (isNew) need(Permission.PRODUCTS_MANAGE, 'create a product', 'product.new');
    if (saveRecipe) need(Permission.BUNDLES_MANAGE, 'save a recipe', 'saveRecipe');
    if (dto.qty > 0) need(Permission.BUNDLING_CREATE, 'post a bundling', 'qty');

    const correlationId = new Types.ObjectId().toString();
    const result = await runInTransaction(this.connection, async (session) => {
      let product: { _id: Types.ObjectId; code: string; name: string };
      let masterBundle = false;
      if (dto.product.new) {
        const draft = dto.product.new;
        const productGroupId = draft.productGroupId ?? (await this.defaultGroupId(session));
        try {
          product = await this.productService.createIn(
            { ...draft, productGroupId, name: draft.name.trim(), type: ProductType.STOCK },
            actor,
            session,
            correlationId,
          );
        } catch (error) {
          if (error instanceof ConflictException) {
            const message = error.message;
            throw new ConflictException({ message, field: message.startsWith('Barcode') ? 'product.new.barcode' : 'product.new.name' });
          }
          throw error;
        }
      } else {
        if (!Types.ObjectId.isValid(dto.product.id!)) throw fieldError(`Product id "${dto.product.id}" is not a valid id`, 'product.id');
        const found = await this.productModel.findById(dto.product.id).select('code name type status isBundle').session(session).lean().exec();
        if (!found) throw new NotFoundException({ message: `Product ${dto.product.id} not found`, field: 'product.id' });
        if (found.status !== ProductStatus.ACTIVE) throw fieldError(`${found.code} is inactive`, 'product.id');
        if (!BUNDLE_OUTPUT_TYPES.includes(found.type)) {
          throw fieldError(`${found.code} is a ${found.type} product: it cannot be bundled`, 'product.id');
        }
        product = found;
        masterBundle = Boolean(found.isBundle);
      }
      const productId = product._id.toString();

      const saved = isNew ? null : await this.recipeModel.findOne({ bundleProductId: product._id }).session(session).lean().exec();
      if (!dto.parts && !saved) throw fieldError(`${product.code} has no saved recipe: add its parts`, 'parts');
      let components = saved?.components ?? [];
      if (dto.parts) {
        await this.assertParts(dto.parts.map((part) => part.productId), productId, 'parts', session);
        const sent = dto.parts.map((part) => ({ productId: new Types.ObjectId(part.productId), qty: roundQty(part.qtyPerBundle) }));
        // A bundle master's recipe is the base: parts sent override its quantities or add extras. Other products: parts replace.
        components = masterBundle && saved
          ? [
              ...saved.components.map((c) => sent.find((s) => s.productId.equals(c.productId)) ?? c),
              ...sent.filter((s) => !saved.components.some((c) => c.productId.equals(s.productId))),
            ]
          : sent;
      }
      const extraCostPerUnit = round2(dto.extraCostPerUnit ?? saved?.extraCostPerUnit ?? 0);

      if (saveRecipe) {
        await this.writeRecipe(product, components, extraCostPerUnit, actor, session, { correlationId, skipIfSame: true });
      }
      const recipe = await this.recipeModel.findOne({ bundleProductId: product._id }).session(session).lean().exec();
      const effective: RecipeLike = { version: recipe?.version ?? 0, extraCostPerUnit, components };

      const doc =
        dto.qty > 0
          ? await this.postIn(
              {
                date: dto.date,
                locationId: dto.locationId,
                mode: dto.mode,
                bundleProductId: productId,
                qty: dto.qty,
                updateBundlePurchasePrice: dto.updateBundlePurchasePrice,
                remarks: dto.remarks,
                extraCosts: dto.extraCosts,
              },
              actor,
              session,
              { correlationId, recipe: effective },
            )
          : null;
      const info = await this.productInfo(components.map((component) => component.productId), session);
      return {
        doc,
        product: { id: productId, code: product.code, name: product.name },
        recipe: recipe && {
          version: recipe.version,
          extraCostPerUnit: recipe.extraCostPerUnit,
          components: recipe.components.map((component) => ({
            productId: component.productId.toString(),
            productCode: info.get(component.productId.toString())?.code ?? null,
            productName: info.get(component.productId.toString())?.name ?? null,
            qtyPerBundle: component.qty,
          })),
        },
      };
    });
    return {
      correlationId,
      product: result.product,
      recipe: result.recipe,
      bundling: result.doc ? await this.view(result.doc, actor) : null,
    };
  }

  /** Needs, stock, FIFO cost per part (oldest layers first) and the estimated cost per bundle. Cost fields need products:view-cost. */
  async preview(dto: PreviewBundlingDto, viewer: Viewer) {
    assertLocationAllowed(viewer, dto.locationId, 'see stock at');
    let components: { productId: Types.ObjectId; qty: number }[];
    let extra = dto.extraCostPerUnit;
    if (dto.parts) {
      await this.assertParts(dto.parts.map((part) => part.productId), dto.productId ?? '', 'parts');
      components = dto.parts.map((part) => ({ productId: new Types.ObjectId(part.productId), qty: roundQty(part.qtyPerBundle) }));
      // Same rule as compose: a bundle master's saved recipe is the base the parts override or extend.
      const master =
        dto.productId && (await this.productModel.exists({ _id: dto.productId, isBundle: true }).exec())
          ? await this.recipeModel.findOne({ bundleProductId: new Types.ObjectId(dto.productId) }).lean().exec()
          : null;
      if (master) {
        const sent = components;
        components = [
          ...master.components.map((c) => sent.find((s) => s.productId.equals(c.productId)) ?? c),
          ...sent.filter((s) => !master.components.some((c) => c.productId.equals(s.productId))),
        ];
        extra ??= master.extraCostPerUnit;
      }
    } else if (dto.productId) {
      const recipe = await this.recipeOf(new Types.ObjectId(dto.productId));
      components = recipe.components;
      extra ??= recipe.extraCostPerUnit;
    } else {
      throw fieldError('Send parts or productId', 'parts');
    }
    const stock = await this.availabilityOf(components, dto.locationId, dto.qty);
    const canCost = hasPermission(viewer, Permission.PRODUCTS_VIEW_COST);
    const costs = canCost
      ? await Promise.all(components.map((component) => this.costService.previewConsume(component.productId, roundQty(component.qty * dto.qty))))
      : [];
    const extraCostPerUnit = round2(extra ?? 0);
    const extraCosts = (dto.extraCosts ?? []).map(({ label, amount }) => ({ label, amount: round2(amount) }));
    const extraCostTotal = round2(extraCostPerUnit * dto.qty + extraCosts.reduce((sum, cost) => sum + cost.amount, 0));
    const partsCost = round2(costs.reduce((sum, cost) => sum + cost.totalCost, 0));
    const totalCost = round2(partsCost + extraCostTotal);
    const costPerBundle = round4(totalCost / dto.qty);
    const suggestedPrice =
      dto.marginPercent === undefined ? undefined : round2(costPerBundle * (1 + dto.marginPercent / 100));
    const profitPerBundle = suggestedPrice === undefined ? 0 : round2(suggestedPrice - costPerBundle);
    return {
      locationId: dto.locationId,
      qty: dto.qty,
      parts: stock.components.map((row, index) => ({
        productId: row.productId,
        productCode: row.productCode,
        productName: row.productName,
        qtyPerBundle: row.requiredPerUnit,
        required: row.requiredTotal,
        available: row.available,
        onHandBefore: row.available,
        onHandAfter: roundQty(row.available - row.requiredTotal),
        short: row.short,
        isShort: row.short > 0,
        ...(canCost ? { fifoCost: costs[index].totalCost, fifoUnitCost: costs[index].avgUnitCost } : {}),
      })),
      maxBundles: stock.maxBundles,
      ...(canCost
        ? {
            extraCostPerUnit,
            extraCosts,
            extraCostTotal,
            partsCost,
            totalCost,
            costPerBundle,
            costPerUnit: costPerBundle,
            ...(suggestedPrice === undefined
              ? {}
              : {
                  marginPercent: dto.marginPercent,
                  suggestedPrice,
                  expectedProfitPerBundle: profitPerBundle,
                  expectedProfitTotal: round2(profitPerBundle * dto.qty),
                }),
          }
        : {}),
    };
  }

  /** The "Gift & Bundle Items" group, else the first group. */
  private async defaultGroupId(session: ClientSession): Promise<string> {
    const group =
      (await this.groupModel.findOne({ name: /^gift & bundle items$/i }).select('_id').session(session).lean().exec()) ??
      (await this.groupModel.findOne().sort({ code: 1 }).select('_id').session(session).lean().exec());
    if (!group) throw fieldError('No product group exists: pick one', 'product.new.productGroupId');
    return group._id.toString();
  }

  // ---- bundling ----

  async findAll(query: BundlingQueryDto = {}, viewer?: Viewer) {
    const filter: Record<string, unknown> = {};
    if (query.dateFrom || query.dateTo) {
      const range: { $gte?: Date; $lte?: Date } = {};
      if (query.dateFrom) range.$gte = new Date(query.dateFrom);
      if (query.dateTo) range.$lte = endOfDayIfDateOnly(query.dateTo);
      filter.date = range;
    }
    if (query.status === 'posted') filter.status = VoucherStatus.POSTED;
    else if (query.status === 'cancelled') filter.status = VoucherStatus.CANCELLED;
    if (query.locationId) filter.locationId = new Types.ObjectId(query.locationId);
    if (query.bundleProductId) filter.bundleProductId = new Types.ObjectId(query.bundleProductId);
    if (query.mode) filter.mode = query.mode;
    const term = query.q?.trim();
    if (term) {
      const pattern = new RegExp(escapeRegExp(term), 'i');
      const products = await this.productModel
        .find({ $or: [{ name: pattern }, { code: pattern }] })
        .select('_id')
        .lean()
        .exec();
      filter.$or = [{ voucherNo: pattern }, { remarks: pattern }, { bundleProductId: { $in: products.map((p) => p._id) } }];
    }
    const scoped = withScope(filter, scopeOf(viewer));
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const [docs, count] = await Promise.all([
      this.model
        .find(scoped)
        .sort({ date: -1, voucherNo: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean()
        .exec(),
      this.model.countDocuments(scoped).exec(),
    ]);
    const [comments, locations, products] = await Promise.all([
      this.commentsService.countByEntityIds(
        BUNDLING_ENTITY_TYPE,
        docs.map((doc) => doc._id),
      ),
      this.locationNames(docs.map((doc) => doc.locationId)),
      this.productInfo(docs.map((doc) => doc.bundleProductId)),
    ]);
    const canCost = hasPermission(viewer, Permission.PRODUCTS_VIEW_COST);
    return {
      items: docs.map((doc) => ({
        id: doc._id.toString(),
        voucherNo: doc.voucherNo,
        date: doc.date,
        location: { id: doc.locationId.toString(), name: locations.get(doc.locationId.toString()) ?? null },
        mode: doc.mode,
        bundleProduct: {
          id: doc.bundleProductId.toString(),
          code: products.get(doc.bundleProductId.toString())?.code ?? null,
          name: products.get(doc.bundleProductId.toString())?.name ?? null,
        },
        qty: doc.qty,
        ...(canCost ? { costPerUnit: doc.costPerUnit } : {}),
        status: doc.status,
        createdBy: userRefOf(doc.createdBy as UserSnapshot | null),
        createdAt: doc.createdAt ?? null,
        commentCount: comments.get(doc._id.toString()) ?? 0,
      })),
      page,
      pageSize,
      summary: { count },
    };
  }

  async findById(id: string, viewer?: Viewer) {
    assertValidId(id);
    const doc = await this.model.findOne(withScope({ _id: new Types.ObjectId(id) }, scopeOf(viewer))).exec();
    if (!doc) throw new NotFoundException(`${LABEL} ${id} not found`);
    return this.view(doc, viewer);
  }

  async create(dto: CreateBundlingDto, actor: Viewer) {
    assertNotFuture(dto.date);
    assertLocationAllowed(actor, dto.locationId, 'bundle at');

    const doc = await runInTransaction(this.connection, (session) => this.postIn(dto, actor, session));
    return this.view(doc, actor);
  }

  /** Posts one bundling in the caller's transaction. `recipe` overrides the saved one (compose with unsaved parts). */
  private async postIn(
    dto: CreateBundlingDto,
    actor: Viewer,
    session: ClientSession,
    options: { correlationId?: string; recipe?: RecipeLike } = {},
  ): Promise<BundlingDocument> {
    {
      const bundleId = new Types.ObjectId(dto.bundleProductId);
      const recipe = options.recipe ?? (await this.recipeOf(bundleId, session));
      await this.stockService.assertHoldsStock(
        [dto.bundleProductId, ...recipe.components.map((component) => component.productId.toString())],
        [dto.locationId],
        session,
      );
      const info = await this.productInfo([bundleId, ...recipe.components.map((component) => component.productId)], session);
      const snapshot: RecipeSnapshot = {
        version: recipe.version,
        extraCostPerUnit: recipe.extraCostPerUnit,
        components: recipe.components.map((component) => ({
          productId: component.productId,
          qty: component.qty,
          unitCost: info.get(component.productId.toString())?.cost ?? 0,
        })),
      };
      let costPerUnit = round2(
        snapshot.components.reduce((sum, component) => sum + component.unitCost * component.qty, 0) +
          snapshot.extraCostPerUnit,
      );
      if (dto.mode === BundlingMode.BUNDLE && !(await this.companyService.ensure()).allowNegativeStock) {
        await this.assertEnough(recipe.components, dto.locationId, dto.qty, session);
      }

      const voucherNo = await this.sequenceService.nextCode(dto.mode === BundlingMode.UNBUNDLE ? SEQUENCE_UNBUNDLE : SEQUENCE, session);
      const now = new Date();
      const [created] = await this.model.create(
        [
          {
            voucherNo,
            date: new Date(dto.date),
            locationId: new Types.ObjectId(dto.locationId),
            mode: dto.mode,
            bundleProductId: bundleId,
            qty: dto.qty,
            updateBundlePurchasePrice: dto.updateBundlePurchasePrice ?? true,
            remarks: dto.remarks,
            recipeSnapshot: snapshot,
            extraCosts: (dto.extraCosts ?? []).map(({ label, amount }) => ({ label, amount: round2(amount) })),
            costPerUnit,
            status: VoucherStatus.POSTED,
            createdBy: toUserSnapshot(actor),
            createdAt: now,
          },
        ],
        { session },
      );
      await this.applyCosting(created, session);
      costPerUnit = created.costPerUnit;
      await this.stockService.post(this.entriesOf(created), actor, session);
      await this.record(created, AuditAction.CREATED, actor, now, session, { correlationId: options.correlationId });

      await this.syncBundlePrice(created, actor, now, session, options.correlationId);
      return created;
    }
  }

  /** Bundle mode: sets the bundle's purchase price to the computed cost (audited), if asked and different. */
  private async syncBundlePrice(doc: BundlingDocument, actor: Viewer, now: Date, session: ClientSession, correlationId?: string) {
    if (doc.mode !== BundlingMode.BUNDLE || !doc.updateBundlePurchasePrice) return;
    const bundle = await this.productModel.findById(doc.bundleProductId).session(session).exec();
    if (!bundle || bundle.purchasePrice === doc.costPerUnit) return;
    const from = bundle.purchasePrice;
    bundle.purchasePrice = doc.costPerUnit;
    await bundle.save({ session });
    await this.auditService.record(
      {
        entityType: PRODUCT_ENTITY_TYPE,
        entityId: bundle._id,
        entityRef: bundle.code,
        action: AuditAction.UPDATED,
        actor,
        at: now,
        changes: [{ field: 'purchasePrice', label: 'Purchase price', from, to: doc.costPerUnit }],
        reason: `Bundling ${doc.voucherNo}`,
        correlationId,
      },
      session,
    );
  }

  /**
   * Edit = reverse the old posting and repost with the new values, same number,
   * one transaction. Mode and bundle product stay; omitted optional fields stay.
   */
  async edit(id: string, dto: EditBundlingDto, actor: Viewer) {
    assertValidId(id);
    assertNotFuture(dto.date);
    assertLocationAllowed(actor, dto.locationId, 'bundle at');
    const correlationId = new Types.ObjectId().toString();

    const doc = await runInTransaction(this.connection, async (session) => {
      const existing = await this.model
        .findOne(withScope({ _id: new Types.ObjectId(id) }, scopeOf(actor)))
        .session(session)
        .exec();
      if (!existing) throw new NotFoundException(`${LABEL} ${id} not found`);
      if (existing.status === VoucherStatus.CANCELLED) {
        throw new BadRequestException(`${LABEL} ${existing.voucherNo} is cancelled and cannot be edited`);
      }
      const bundle = existing.mode === BundlingMode.BUNDLE;
      if (!bundle && (dto.parts || dto.extraCosts || dto.extraCostPerUnit !== undefined)) {
        throw fieldError('An unbundle has no parts or extra costs to change', 'parts');
      }
      const was = existing.recipeSnapshot.components.map((c) => ({ productId: c.productId, qty: c.qty }));
      let components = was;
      if (dto.parts) {
        await this.assertParts(dto.parts.map((part) => part.productId), existing.bundleProductId.toString(), 'parts', session);
        components = dto.parts.map((part) => ({ productId: new Types.ObjectId(part.productId), qty: roundQty(part.qtyPerBundle) }));
      }
      const extraCostPerUnit = round2(dto.extraCostPerUnit ?? existing.recipeSnapshot.extraCostPerUnit);
      const wasExtras = existing.extraCosts.map(({ label, amount }) => ({ label, amount }));
      const extraCosts = dto.extraCosts ? dto.extraCosts.map(({ label, amount }) => ({ label, amount: round2(amount) })) : wasExtras;
      const remarks = dto.remarks ?? existing.remarks;
      const updatePrice = dto.updateBundlePurchasePrice ?? existing.updateBundlePurchasePrice;
      const newDate = new Date(dto.date);

      const partsKey = (list: readonly { productId: Types.ObjectId; qty: number }[]) =>
        list.map((c) => `${c.productId.toString()}x${c.qty}`).sort().join(',');
      const extrasKey = (list: readonly { label: string; amount: number }[]) => JSON.stringify(list.map((e) => [e.label, e.amount]));
      if (
        existing.date.getTime() === newDate.getTime() &&
        existing.locationId.toString() === dto.locationId &&
        existing.qty === dto.qty &&
        partsKey(was) === partsKey(components) &&
        existing.recipeSnapshot.extraCostPerUnit === extraCostPerUnit &&
        extrasKey(wasExtras) === extrasKey(extraCosts) &&
        (existing.remarks ?? '') === (remarks ?? '') &&
        existing.updateBundlePurchasePrice === updatePrice
      ) {
        throw new BadRequestException('No changes to save');
      }

      const info = await this.productInfo([...was, ...components].map((c) => c.productId), session);
      const locations = await this.locationNames([existing.locationId, new Types.ObjectId(dto.locationId)], session);
      const partsText = (list: readonly { productId: Types.ObjectId; qty: number }[]) =>
        list.map((c) => `${info.get(c.productId.toString())?.name ?? c.productId.toString()} x ${c.qty}`).join(', ');
      const extrasText = (list: readonly { label: string; amount: number }[]) => list.map((e) => `${e.label} ${e.amount}`).join(', ');
      const changes: AuditChange[] = [];
      const note = (field: string, label: string, from: string | number | boolean | null, to: string | number | boolean | null) => {
        if (from !== to) changes.push({ field, label, from, to });
      };
      note('date', 'Date', existing.date.toISOString().slice(0, 10), newDate.toISOString().slice(0, 10));
      note('location', 'Location', locations.get(existing.locationId.toString()) ?? null, locations.get(dto.locationId) ?? null);
      note('qty', 'Qty', existing.qty, dto.qty);
      note('parts', 'Parts', partsText(was), partsText(components));
      note('extraCostPerUnit', 'Extra cost per unit', existing.recipeSnapshot.extraCostPerUnit, extraCostPerUnit);
      note('extraCosts', 'Extra costs', extrasText(wasExtras), extrasText(extraCosts));
      note('remarks', 'Remarks', existing.remarks ?? null, remarks ?? null);
      note('updateBundlePurchasePrice', 'Update purchase price', existing.updateBundlePurchasePrice, updatePrice);

      await this.reverseIn(existing, actor, session, 'edit');
      existing.date = newDate;
      existing.locationId = new Types.ObjectId(dto.locationId);
      existing.qty = dto.qty;
      existing.remarks = remarks;
      existing.updateBundlePurchasePrice = updatePrice;
      existing.extraCosts = extraCosts;
      existing.recipeSnapshot = {
        version: existing.recipeSnapshot.version,
        extraCostPerUnit,
        components: components.map((c) => ({ productId: c.productId, qty: c.qty, unitCost: info.get(c.productId.toString())?.cost ?? 0 })),
      };
      await this.stockService.assertHoldsStock(
        [existing.bundleProductId.toString(), ...components.map((c) => c.productId.toString())],
        [dto.locationId],
        session,
      );
      if (bundle && !(await this.companyService.ensure()).allowNegativeStock) {
        await this.assertEnough(components, dto.locationId, dto.qty, session);
      }
      await this.applyCosting(existing, session);
      await this.stockService.post(this.entriesOf(existing), actor, session);
      const now = new Date();
      await this.syncBundlePrice(existing, actor, now, session, correlationId);
      await this.record(existing, AuditAction.UPDATED, actor, now, session, { changes, correlationId });
      return existing;
    });
    return this.view(doc, actor);
  }

  /** Takes a posting back: cost layers, costing and stock entries. Refused if the stock was already used or sold. */
  private async reverseIn(doc: BundlingDocument, actor: Viewer, session: ClientSession, verb: 'undo' | 'edit') {
    await this.costService.removeLayers(BUNDLING_ENTITY_TYPE, doc._id, `${LABEL} ${doc.voucherNo}`, verb === 'undo' ? 'undone' : 'edited', session);
    await this.costService.reverseAll({ voucherType: BUNDLING_ENTITY_TYPE, voucherId: doc._id }, session);
    try {
      await this.stockService.post(await this.stockService.reversalsOf(BUNDLING_ENTITY_TYPE, doc._id, session), actor, session, {
        strict: true,
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw new BadRequestException(`Cannot ${verb} ${doc.voucherNo}, the stock was already used or sold. ${error.message}`);
      }
      throw error;
    }
  }

  /** Undo: reverses the entries; refused if any balance would go below zero (e.g. the boxes were sold). */
  async cancel(id: string, dto: CancelBundlingDto, actor: Viewer) {
    const reason = dto.reason.trim();
    assertValidId(id);

    const doc = await runInTransaction(this.connection, async (session) => {
      const existing = await this.model
        .findOne(withScope({ _id: new Types.ObjectId(id) }, scopeOf(actor)))
        .session(session)
        .exec();
      if (!existing) throw new NotFoundException(`${LABEL} ${id} not found`);
      if (existing.status === VoucherStatus.CANCELLED) {
        throw new BadRequestException(`${LABEL} ${existing.voucherNo} is cancelled and cannot be cancelled again`);
      }
      await this.reverseIn(existing, actor, session, 'undo');
      const now = new Date();
      existing.status = VoucherStatus.CANCELLED;
      existing.cancelledBy = toUserSnapshot(actor);
      existing.cancelledAt = now;
      existing.cancelReason = reason;
      await existing.save({ session });
      await this.record(existing, AuditAction.CANCELLED, actor, now, session, {
        changes: [{ field: 'status', label: 'Status', from: VoucherStatus.POSTED, to: VoucherStatus.CANCELLED }],
        reason,
      });
      return existing;
    });
    return this.view(doc, actor);
  }

  /** BUNDLING NOTE: parts, bundle, cost per unit (cost only with products:view-cost). Every call is audited. */
  async pdf(id: string, viewer: Viewer, requestedSize?: string): Promise<{ buffer: Buffer; filename: string }> {
    assertValidId(id);
    const size = printLayout.resolveSize(requestedSize, 'other', (await this.companyService.ensure()).printDefaults);
    const canCost = hasPermission(viewer, Permission.PRODUCTS_VIEW_COST);
    return runInTransaction(this.connection, async (session) => {
      const doc = await this.model
        .findOneAndUpdate(
          withScope({ _id: new Types.ObjectId(id) }, scopeOf(viewer)),
          { $inc: { printCount: 1 } },
          { returnDocument: 'after', session },
        )
        .exec();
      if (!doc) throw new NotFoundException(`${LABEL} ${id} not found`);
      const info = await this.productInfo(
        [doc.bundleProductId, ...doc.recipeSnapshot.components.map((component) => component.productId)],
        session,
      );
      const location = (await this.locationNames([doc.locationId], session)).get(doc.locationId.toString()) ?? '';
      const bundle = info.get(doc.bundleProductId.toString());
      const bundling = doc.mode === BundlingMode.BUNDLE;
      const parts = doc.recipeSnapshot.components.map((component) => {
        const product = info.get(component.productId.toString());
        return [product?.code ?? '', product?.name ?? '', String(roundQty(component.qty * doc.qty))];
      });
      const table = (title: string, rows: string[][]): Content[] => [
        { text: title, bold: true, margin: [0, 10, 0, 4] },
        {
          table: {
            headerRows: 1,
            widths: [80, '*', 60],
            body: [['Code', 'Product', 'Qty'].map((text) => ({ text, bold: true })), ...rows],
          },
        },
      ];
      const definition: TDocumentDefinitions = printLayout.apply({
        info: { title: `BUNDLING NOTE ${doc.voucherNo}` },
        pageSize: 'A4',
        content: [
          { text: 'BUNDLING NOTE', fontSize: 16, bold: true, margin: [0, 0, 0, 6] },
          {
            text: [
              `No: ${doc.voucherNo}`,
              `Date: ${doc.date.toISOString().slice(0, 10)}`,
              `Location: ${location}`,
              `Type: ${bundling ? 'Bundle' : 'Unbundle'}`,
              ...(doc.status === VoucherStatus.CANCELLED ? ['CANCELLED'] : []),
            ].join('   '),
            margin: [0, 0, 0, 4],
          },
          ...table(bundling ? 'Parts used' : 'Parts returned', parts),
          ...table(bundling ? 'Bundle made' : 'Bundle used', [[bundle?.code ?? '', bundle?.name ?? '', String(doc.qty)]]),
          ...(canCost ? [{ text: `Cost per unit: ${doc.costPerUnit.toFixed(2)}`, margin: [0, 10, 0, 0] } as Content] : []),
          ...(doc.remarks ? [{ text: `Remarks: ${doc.remarks}`, margin: [0, 6, 0, 0] } as Content] : []),
        ],
        defaultStyle: { fontSize: 9 },
      }, size);
      const buffer = await renderPdf(definition);
      await this.record(doc, AuditAction.PRINTED, viewer, new Date(), session, {
        changes: [{ field: 'size', label: 'Size', from: null, to: size }],
      });
      return { buffer, filename: `${doc.voucherNo}.pdf` };
    });
  }

  // ---- internals ----

  /**
   * Bundle: components are consumed FIFO and the bundle layer costs their
   * consumed cost / qty + extraCostPerUnit (expiry = the earliest batch used).
   * Unbundle: the bundle's layers are consumed and each component comes back
   * as a new layer at its latest layer cost. Fills in the actual costs on the doc.
   */
  private async applyCosting(doc: BundlingDocument, session: ClientSession): Promise<void> {
    const ref = (lineId: Types.ObjectId): CostRef => ({ voucherType: BUNDLING_ENTITY_TYPE, voucherId: doc._id, voucherNo: doc.voucherNo, lineId });
    if (doc.mode === BundlingMode.BUNDLE) {
      let total = 0;
      let expiry: Date | null = null;
      for (const component of doc.recipeSnapshot.components) {
        const qty = roundQty(component.qty * doc.qty);
        const cost = await this.costService.consume(component.productId, qty, ref(component.productId), session);
        component.unitCost = cost.avgUnitCost;
        total += cost.totalCost;
        for (const used of cost.consumptions) {
          if (used.expiryDate && (!expiry || used.expiryDate < expiry)) expiry = used.expiryDate;
        }
      }
      const extraTotal = round2(doc.recipeSnapshot.extraCostPerUnit * doc.qty + (doc.extraCosts ?? []).reduce((sum, e) => sum + e.amount, 0));
      doc.costPerUnit = round4((total + extraTotal) / doc.qty);
      await this.costService.addLayer(
        { productId: doc.bundleProductId, sourceType: BUNDLING_ENTITY_TYPE, sourceVoucherId: doc._id, date: doc.date, qty: doc.qty, unitCost: doc.costPerUnit, expiryDate: expiry },
        session,
      );
    } else {
      const consumed = await this.costService.consume(doc.bundleProductId, doc.qty, ref(doc.bundleProductId), session);
      doc.costPerUnit = consumed.avgUnitCost;
      // Parts come back at what they originally cost: the part costs of the bundlings that made the bundle layers used.
      const layerIds = consumed.consumptions.flatMap((used) => (used.layerId ? [used.layerId] : []));
      const layers = await this.layerModel.find({ _id: { $in: layerIds } }).select('sourceType sourceVoucherId').session(session).lean().exec();
      const origins = await this.model
        .find({ _id: { $in: layers.filter((layer) => layer.sourceType === BUNDLING_ENTITY_TYPE).map((layer) => layer.sourceVoucherId) } })
        .select('recipeSnapshot')
        .session(session)
        .lean()
        .exec();
      for (const component of doc.recipeSnapshot.components) {
        const latest = await this.costService.latestCost(component.productId, session);
        let total = 0;
        for (const used of consumed.consumptions) {
          const layer = used.layerId ? layers.find((candidate) => candidate._id.equals(used.layerId!)) : undefined;
          const origin = layer && origins.find((candidate) => candidate._id.equals(layer.sourceVoucherId));
          const original = origin?.recipeSnapshot.components.find((c) => c.productId.equals(component.productId))?.unitCost;
          total += used.qty * (original ?? latest);
        }
        component.unitCost = round4(total / doc.qty);
        await this.costService.addLayer(
          { productId: component.productId, sourceType: BUNDLING_ENTITY_TYPE, sourceVoucherId: doc._id, date: doc.date, qty: roundQty(component.qty * doc.qty), unitCost: component.unitCost },
          session,
        );
      }
    }
    await doc.save({ session });
  }

  /** Bundle: components out, bundle in. Unbundle: the bundle out, components in. */
  private entriesOf(doc: BundlingDocument): StockEntryInput[] {
    const base = {
      locationId: doc.locationId,
      date: doc.date,
      voucherType: BUNDLING_ENTITY_TYPE,
      voucherId: doc._id,
      voucherNo: doc.voucherNo,
    };
    const sign = doc.mode === BundlingMode.BUNDLE ? -1 : 1;
    return [
      ...doc.recipeSnapshot.components.map((component) => ({
        ...base,
        productId: component.productId,
        qty: sign * roundQty(component.qty * doc.qty),
        unitCost: component.unitCost,
        costing: sign === -1 ? ('consume' as const) : ('layer-add' as const),
      })),
      {
        ...base,
        productId: doc.bundleProductId,
        qty: -sign * doc.qty,
        unitCost: doc.costPerUnit,
        costing: sign === -1 ? ('layer-add' as const) : ('consume' as const),
      },
    ];
  }

  private async recipeOf(bundleProductId: Types.ObjectId, session?: ClientSession) {
    const product = await this.productModel
      .findById(bundleProductId)
      .select('code type')
      .session(session ?? null)
      .lean()
      .exec();
    if (!product) throw new NotFoundException(`Product ${bundleProductId.toString()} not found`);
    if (!BUNDLE_OUTPUT_TYPES.includes(product.type)) {
      throw new BadRequestException(`${product.code} is a ${product.type} product: it cannot be bundled`);
    }
    const recipe = await this.recipeModel
      .findOne({ bundleProductId })
      .session(session ?? null)
      .lean()
      .exec();
    if (!recipe) throw new BadRequestException(`${product.code} has no recipe`);
    return recipe;
  }

  private async bundleProduct(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException(`Product id "${id}" is not a valid id`);
    const product = await this.productModel.findById(id).select('code name type').lean().exec();
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    if (!BUNDLE_OUTPUT_TYPES.includes(product.type)) {
      throw new BadRequestException(`${product.code} is a ${product.type} product: it cannot be bundled`);
    }
    return product;
  }

  private async availabilityOf(
    components: readonly { productId: Types.ObjectId; qty: number }[],
    locationId: string,
    qty: number,
    session?: ClientSession,
  ) {
    const productIds = components.map((component) => component.productId);
    const balances = await this.balanceModel
      .find({ locationId: new Types.ObjectId(locationId), productId: { $in: productIds } })
      .session(session ?? null)
      .lean()
      .exec();
    const info = await this.productInfo(productIds, session);
    const rows = components.map((component) => {
      const available = roundQty(balances.find((balance) => balance.productId.equals(component.productId))?.qty ?? 0);
      const required = roundQty(component.qty * qty);
      return {
        productId: component.productId.toString(),
        productCode: info.get(component.productId.toString())?.code ?? null,
        productName: info.get(component.productId.toString())?.name ?? null,
        requiredPerUnit: component.qty,
        requiredTotal: required,
        available,
        short: roundQty(Math.max(0, required - available)),
        makeable: Math.max(0, Math.floor(roundQty(available / component.qty))),
      };
    });
    return {
      locationId,
      qty,
      components: rows.map(({ makeable: _makeable, ...row }) => row),
      maxBundles: rows.length ? Math.min(...rows.map((row) => row.makeable)) : 0,
    };
  }

  /** One message naming every short component, with how many bundles can be made. */
  private async assertEnough(
    components: readonly { productId: Types.ObjectId; qty: number }[],
    locationId: string,
    qty: number,
    session: ClientSession,
  ) {
    const result = await this.availabilityOf(components, locationId, qty, session);
    const short = result.components.filter((row) => row.short > 0);
    if (short.length === 0) return;
    throw fieldError(
      `Not enough parts to make ${qty}: ${short
        .map((row) => `${row.productCode} (${row.productName}) needs ${row.requiredTotal}, has ${row.available}, short by ${row.short}`)
        .join('; ')}. Max you can make: ${result.maxBundles}`,
      'qty',
    );
  }

  /** API shape; costs only with products:view-cost. */
  private async view(doc: BundlingDocument, viewer: Viewer | undefined) {
    const canCost = hasPermission(viewer, Permission.PRODUCTS_VIEW_COST);
    const info = await this.productInfo([
      doc.bundleProductId,
      ...doc.recipeSnapshot.components.map((component) => component.productId),
    ]);
    const location = (await this.locationNames([doc.locationId])).get(doc.locationId.toString()) ?? null;
    const bundle = info.get(doc.bundleProductId.toString());
    return {
      id: doc._id.toString(),
      voucherNo: doc.voucherNo,
      date: doc.date,
      location: { id: doc.locationId.toString(), name: location },
      mode: doc.mode,
      bundleProduct: { id: doc.bundleProductId.toString(), code: bundle?.code ?? null, name: bundle?.name ?? null },
      qty: doc.qty,
      updateBundlePurchasePrice: doc.updateBundlePurchasePrice,
      remarks: doc.remarks ?? null,
      recipeSnapshot: {
        version: doc.recipeSnapshot.version,
        ...(canCost ? { extraCostPerUnit: doc.recipeSnapshot.extraCostPerUnit } : {}),
        components: doc.recipeSnapshot.components.map((component) => ({
          productId: component.productId.toString(),
          productCode: info.get(component.productId.toString())?.code ?? null,
          productName: info.get(component.productId.toString())?.name ?? null,
          qty: component.qty,
          totalQty: roundQty(component.qty * doc.qty),
          ...(canCost ? { unitCost: component.unitCost } : {}),
        })),
      },
      ...(canCost ? { costPerUnit: doc.costPerUnit, extraCosts: (doc.extraCosts ?? []).map(({ label, amount }) => ({ label, amount })) } : {}),
      status: doc.status,
      createdBy: userRefOf(doc.createdBy as UserSnapshot | null),
      createdAt: doc.createdAt ?? null,
      cancelledBy: userRefOf(doc.cancelledBy as UserSnapshot | null),
      cancelledAt: doc.cancelledAt ?? null,
      cancelReason: doc.cancelReason ?? null,
    };
  }

  private async productInfo(ids: Types.ObjectId[], session?: ClientSession): Promise<Map<string, ProductInfo>> {
    const products = await this.productModel
      .find({ _id: { $in: ids } })
      .select('code name purchasePrice')
      .session(session ?? null)
      .lean()
      .exec();
    return new Map(
      products.map((product) => [
        product._id.toString(),
        { code: product.code, name: product.name, cost: product.purchasePrice ?? 0 },
      ]),
    );
  }

  private async locationNames(ids: Types.ObjectId[], session?: ClientSession): Promise<Map<string, string>> {
    const locations = await this.locationModel
      .find({ _id: { $in: ids } })
      .select('name')
      .session(session ?? null)
      .lean()
      .exec();
    return new Map(locations.map((location) => [location._id.toString(), location.name]));
  }

  private record(
    doc: BundlingDocument,
    action: AuditAction,
    actor: Viewer,
    at: Date,
    session: ClientSession,
    extra: { changes?: AuditChange[]; reason?: string; correlationId?: string } = {},
  ) {
    return this.auditService.record(
      { entityType: BUNDLING_ENTITY_TYPE, entityId: doc._id, entityRef: doc.voucherNo, action, actor, at, ...extra },
      session,
    );
  }
}

const round4 = (value: number) => Math.round(value * 10000) / 10000;

/** 400 that tells the client which request field to highlight. */
function fieldError(message: string, field: string): BadRequestException {
  return new BadRequestException({ message, field });
}

/** "own"-scoped users: only vouchers at their allowed locations. */
function scopeOf(user: Viewer | undefined): Record<string, unknown> | null {
  const allowed = stockLocationScope(user);
  return allowed ? { locationId: { $in: allowed.map((id) => new Types.ObjectId(id)) } } : null;
}

function assertLocationAllowed(user: Viewer, locationId: string, action: string): void {
  const allowed = stockLocationScope(user);
  if (allowed && !allowed.includes(locationId)) {
    throw new ForbiddenException(`You may not ${action} this location`);
  }
}

/** Today is taken in Asia/Dubai (UTC+4, no DST). */
function assertNotFuture(date: string): void {
  const today = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (date.slice(0, 10) > today) {
    throw new BadRequestException('The date cannot be in the future');
  }
}

function assertValidId(id: string): void {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestException(`${LABEL} id "${id}" is not a valid id`);
  }
}

/** A date-only filter bound covers the whole day. */
function endOfDayIfDateOnly(value: string): Date {
  const date = new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
}
