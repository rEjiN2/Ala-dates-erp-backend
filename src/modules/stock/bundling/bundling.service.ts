import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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
  CreateBundlingDto,
  SetRecipeDto,
} from './dto/bundling.dto.js';
import { StockService, roundQty, stockLocationScope, type StockEntryInput } from '../stock.service.js';
import { StockBalance, StockBalanceDocument } from '../schemas/stock-balance.schema.js';
import {
  PRODUCT_ENTITY_TYPE,
  Product,
  ProductDocument,
  ProductType,
} from '../../product/products/schemas/product.schema.js';
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
import { round2 } from '../../../common/utils/money.util.js';

type Viewer = AuthenticatedUser;

const SEQUENCE = { key: 'bundling', prefix: 'BND-', width: 4 };
const LABEL = 'Bundling';

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
@Injectable()
export class BundlingService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Bundling.name) private readonly model: Model<BundlingDocument>,
    @InjectModel(BundleRecipe.name) private readonly recipeModel: Model<BundleRecipeDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(Location.name) private readonly locationModel: Model<LocationDocument>,
    @InjectModel(StockBalance.name) private readonly balanceModel: Model<StockBalanceDocument>,
    private readonly stockService: StockService,
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
    if (new Set(ids).size !== ids.length) throw new BadRequestException('A component is on more than one line');
    if (ids.includes(productId)) throw new BadRequestException('A bundle cannot contain itself');
    const products = await this.productModel
      .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } })
      .select('code name type')
      .lean()
      .exec();
    for (const id of ids) {
      const product = products.find((candidate) => candidate._id.toString() === id);
      if (!product) throw new NotFoundException(`Product ${id} not found`);
      if (product.type !== ProductType.STOCK) {
        throw new BadRequestException(
          `${product.code} (${product.name}) is a ${product.type} product: components must be stock products`,
        );
      }
    }
    const components = dto.components.map((component) => ({
      productId: new Types.ObjectId(component.productId),
      qty: roundQty(component.qty),
    }));
    const extraCostPerUnit = round2(dto.extraCostPerUnit);

    await runInTransaction(this.connection, async (session) => {
      const existing = await this.recipeModel.findOne({ bundleProductId: bundle._id }).session(session).lean().exec();
      const describe = (list: readonly { productId: Types.ObjectId; qty: number }[]) =>
        list
          .map((component) => `${component.productId.toString()}x${component.qty}`)
          .sort()
          .join(',');
      if (existing && existing.extraCostPerUnit === extraCostPerUnit && describe(existing.components) === describe(components)) {
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
        },
        session,
      );
    });
    return this.getRecipe(productId);
  }

  /** Per component: needed per unit and in total, on hand at the location, short; and how many bundles can be made. */
  async availability(productId: string, query: AvailabilityQueryDto, viewer: Viewer) {
    assertLocationAllowed(viewer, query.locationId, 'see stock at');
    if (!Types.ObjectId.isValid(productId)) throw new BadRequestException(`Product id "${productId}" is not a valid id`);
    const recipe = await this.recipeOf(new Types.ObjectId(productId));
    return this.availabilityOf(recipe.components, query.locationId, query.qty ?? 1);
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
        .find({ type: ProductType.BUNDLE, $or: [{ name: pattern }, { code: pattern }] })
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

    const doc = await runInTransaction(this.connection, async (session) => {
      const bundleId = new Types.ObjectId(dto.bundleProductId);
      const recipe = await this.recipeOf(bundleId, session);
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
      const costPerUnit = round2(
        snapshot.components.reduce((sum, component) => sum + component.unitCost * component.qty, 0) +
          snapshot.extraCostPerUnit,
      );
      if (dto.mode === BundlingMode.BUNDLE && !(await this.companyService.ensure()).allowNegativeStock) {
        await this.assertEnough(recipe.components, dto.locationId, dto.qty, session);
      }

      const voucherNo = await this.sequenceService.nextCode(SEQUENCE, session);
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
            costPerUnit,
            status: VoucherStatus.POSTED,
            createdBy: toUserSnapshot(actor),
            createdAt: now,
          },
        ],
        { session },
      );
      await this.stockService.post(this.entriesOf(created), actor, session);
      await this.record(created, AuditAction.CREATED, actor, now, session);

      const bundle = await this.productModel.findById(bundleId).session(session).exec();
      if (
        created.mode === BundlingMode.BUNDLE &&
        created.updateBundlePurchasePrice &&
        bundle &&
        bundle.purchasePrice !== costPerUnit
      ) {
        const from = bundle.purchasePrice;
        bundle.purchasePrice = costPerUnit;
        await bundle.save({ session });
        await this.auditService.record(
          {
            entityType: PRODUCT_ENTITY_TYPE,
            entityId: bundle._id,
            entityRef: bundle.code,
            action: AuditAction.UPDATED,
            actor,
            at: now,
            changes: [{ field: 'purchasePrice', label: 'Purchase price', from, to: costPerUnit }],
            reason: `Bundling ${voucherNo}`,
          },
          session,
        );
      }
      return created;
    });
    return this.view(doc, actor);
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
      try {
        await this.stockService.post(
          await this.stockService.reversalsOf(BUNDLING_ENTITY_TYPE, existing._id, session),
          actor,
          session,
          { strict: true },
        );
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw new BadRequestException(
            `Cannot undo ${existing.voucherNo}, the stock was already used or sold. ${error.message}`,
          );
        }
        throw error;
      }
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
  async pdf(id: string, viewer: Viewer): Promise<{ buffer: Buffer; filename: string }> {
    assertValidId(id);
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
      const definition: TDocumentDefinitions = {
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
      };
      const buffer = await renderPdf(definition);
      await this.record(doc, AuditAction.PRINTED, viewer, new Date(), session);
      return { buffer, filename: `${doc.voucherNo}.pdf` };
    });
  }

  // ---- internals ----

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
      })),
      { ...base, productId: doc.bundleProductId, qty: -sign * doc.qty, unitCost: doc.costPerUnit },
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
    if (product.type !== ProductType.BUNDLE) throw new BadRequestException(`${product.code} is not a bundle product`);
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
    if (product.type !== ProductType.BUNDLE) throw new BadRequestException(`${product.code} is not a bundle product`);
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
    throw new BadRequestException(
      `Not enough parts to make ${qty}: ${short
        .map((row) => `${row.productCode} (${row.productName}) needs ${row.requiredTotal}, has ${row.available}`)
        .join('; ')}. Max you can make: ${result.maxBundles}`,
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
      ...(canCost ? { costPerUnit: doc.costPerUnit } : {}),
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
    extra: { changes?: AuditChange[]; reason?: string } = {},
  ) {
    return this.auditService.record(
      { entityType: BUNDLING_ENTITY_TYPE, entityId: doc._id, entityRef: doc.voucherNo, action, actor, at, ...extra },
      session,
    );
  }
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
