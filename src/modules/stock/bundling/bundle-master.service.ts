import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model, QueryFilter } from 'mongoose';
import { BundlingService } from './bundling.service.js';
import { BundleRecipe, BundleRecipeDocument } from './schemas/bundle-recipe.schema.js';
import {
  BundleMasterQueryDto,
  BundleMasterStatusDto,
  CreateBundleMasterDto,
  UpdateBundleMasterDto,
} from './dto/bundle-master.dto.js';
import { roundQty } from '../stock.service.js';
import { Product, ProductDocument, ProductStatus, ProductType } from '../../product/products/schemas/product.schema.js';
import { ProductService } from '../../product/products/product.service.js';
import type { UpdateProductDto } from '../../product/products/dto/product.dto.js';
import { escapeRegExp } from '../../sequence/code-sequence.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';
import { round2 } from '../../../common/utils/money.util.js';

const PRODUCT_FIELDS = ['name', 'productGroupId', 'unitId', 'salePrice', 'vatRate', 'barcode'] as const;

/**
 * Bundle master: a product flagged isBundle plus its recipe, written together in
 * one transaction (audited under one correlation id). Packing still goes through
 * /bundlings/preview and /bundlings/compose.
 */
@Injectable()
export class BundleMasterService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(BundleRecipe.name) private readonly recipeModel: Model<BundleRecipeDocument>,
    private readonly productService: ProductService,
    private readonly bundlingService: BundlingService,
  ) {}

  async findAll(query: BundleMasterQueryDto) {
    const filter: QueryFilter<ProductDocument> = { isBundle: true };
    if (query.status) filter.status = query.status;
    const term = query.q?.trim();
    if (term) {
      const pattern = new RegExp(escapeRegExp(term), 'i');
      filter.$or = [{ name: pattern }, { code: pattern }, { barcode: pattern }];
    }
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [products, total] = await Promise.all([
      this.productModel
        .find(filter)
        .sort({ code: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean()
        .exec(),
      this.productModel.countDocuments(filter).exec(),
    ]);
    return { items: await this.views(products), total, page, pageSize };
  }

  async findById(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException(`Bundle id "${id}" is not a valid id`);
    const product = await this.productModel.findOne({ _id: id, isBundle: true }).lean().exec();
    if (!product) throw new NotFoundException(`Bundle ${id} not found`);
    return (await this.views([product]))[0];
  }

  async create(dto: CreateBundleMasterDto, actor: AuthenticatedUser) {
    const correlationId = new Types.ObjectId().toString();
    const id = await runInTransaction(this.connection, async (session) => {
      const components = await this.checkedParts(dto, '', session);
      const product = await this.productService.createIn(
        {
          name: dto.name,
          productGroupId: dto.productGroupId,
          unitId: dto.unitId,
          salePrice: dto.salePrice,
          vatRate: dto.vatRate,
          barcode: dto.barcode,
          status: dto.status,
          type: ProductType.STOCK,
          isBundle: true,
        },
        actor,
        session,
        correlationId,
      );
      await this.bundlingService.writeRecipe(product, components, round2(dto.defaultExtraCostPerUnit ?? 0), actor, session, {
        correlationId,
      });
      return product._id.toString();
    });
    return this.findById(id);
  }

  /** Updates the product fields and replaces the recipe. Past bundlings keep their own snapshot. */
  async update(id: string, dto: UpdateBundleMasterDto, actor: AuthenticatedUser) {
    const correlationId = new Types.ObjectId().toString();
    await runInTransaction(this.connection, async (session) => {
      const bundle = await this.productModel.findOne({ _id: id, isBundle: true }).session(session).lean().exec();
      if (!bundle) throw new NotFoundException(`Bundle ${id} not found`);
      const components = await this.checkedParts(dto, id, session);
      const existing = await this.recipeModel.findOne({ bundleProductId: bundle._id }).session(session).lean().exec();

      const fields: Record<string, unknown> = {};
      for (const key of PRODUCT_FIELDS) if (dto[key] !== undefined) fields[key] = dto[key];
      const productChanged = await this.productService.updateIn(id, fields as UpdateProductDto, actor, session, {
        correlationId,
        tolerateNoChange: true,
      });
      const recipeChanged = await this.bundlingService.writeRecipe(
        bundle,
        components,
        round2(dto.defaultExtraCostPerUnit ?? existing?.extraCostPerUnit ?? 0),
        actor,
        session,
        { correlationId, skipIfSame: true },
      );
      if (!productChanged && !recipeChanged) throw new BadRequestException('No changes to save');
    });
    return this.findById(id);
  }

  /** Deactivate or reactivate; a bundle with bundlings cannot be deleted, only made inactive. */
  async setStatus(id: string, dto: BundleMasterStatusDto, actor: AuthenticatedUser) {
    await this.findById(id);
    await runInTransaction(this.connection, (session) =>
      this.productService.updateIn(id, { status: dto.status }, actor, session),
    );
    return this.findById(id);
  }

  /** Parts: unique, not the bundle itself, active stock products that are not bundles; qty rounded to 3 decimals. */
  private async checkedParts(dto: { parts: { productId: string; qtyPerBundle: number }[] }, outputId: string, session: ClientSession) {
    const ids = dto.parts.map((part) => part.productId);
    await this.bundlingService.assertParts(ids, outputId, 'parts', session);
    const products = await this.productModel
      .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } })
      .select('code name status')
      .session(session)
      .lean()
      .exec();
    for (const [index, id] of ids.entries()) {
      const product = products.find((candidate) => candidate._id.toString() === id);
      if (product && product.status !== ProductStatus.ACTIVE) {
        throw new BadRequestException({
          message: `${product.code} (${product.name}) is inactive: parts must be active stock products`,
          field: `parts.${index}.productId`,
        });
      }
    }
    return dto.parts.map((part) => ({ productId: new Types.ObjectId(part.productId), qty: roundQty(part.qtyPerBundle) }));
  }

  private async views(products: (Product & { _id: Types.ObjectId })[]) {
    const recipes = await this.recipeModel
      .find({ bundleProductId: { $in: products.map((product) => product._id) } })
      .lean()
      .exec();
    const partIds = recipes.flatMap((recipe) => recipe.components.map((component) => component.productId));
    const parts = new Map(
      (await this.productModel.find({ _id: { $in: partIds } }).select('code name').lean().exec()).map((p) => [p._id.toString(), p]),
    );
    return products.map((product) => {
      const recipe = recipes.find((candidate) => candidate.bundleProductId.equals(product._id));
      return {
        id: product._id.toString(),
        code: product.code,
        name: product.name,
        productGroupId: product.productGroupId.toString(),
        unitId: product.unitId.toString(),
        salePrice: product.salePrice,
        vatRate: product.vatRate,
        barcode: product.barcode ?? null,
        status: product.status,
        defaultExtraCostPerUnit: recipe?.extraCostPerUnit ?? 0,
        recipeVersion: recipe?.version ?? 0,
        parts: (recipe?.components ?? []).map((component) => ({
          productId: component.productId.toString(),
          productCode: parts.get(component.productId.toString())?.code ?? null,
          productName: parts.get(component.productId.toString())?.name ?? null,
          qtyPerBundle: component.qty,
        })),
      };
    });
  }
}
