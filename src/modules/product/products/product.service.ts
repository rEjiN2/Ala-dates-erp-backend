import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model, QueryFilter } from 'mongoose';
import {
  PRODUCT_ENTITY_TYPE,
  PRODUCT_NAME_COLLATION,
  Product,
  ProductDocument,
  ProductStatus,
  ProductType,
} from './schemas/product.schema.js';
import { CreateProductDto, ProductLookupQueryDto, ProductQueryDto, UpdateProductDto } from './dto/product.dto.js';
import { PRODUCT_CODE_SEQUENCE } from './product-code.js';
import { ProductUsageRegistry } from './product-usage.registry.js';
import { ProductGroup, ProductGroupDocument } from '../product-groups/schemas/product-group.schema.js';
import { Unit, UnitDocument } from '../units/schemas/unit.schema.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { escapeRegExp } from '../../sequence/code-sequence.js';
import { FilesService } from '../../files/files.service.js';
import { FileOwnerType } from '../../files/schemas/file-attachment.schema.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction, type AuditChange } from '../../audit/schemas/audit-log.schema.js';
import { diffFields, type DiffField } from '../../audit/field-diff.js';
import { EntityAccessRegistry } from '../../comments/entity-access.registry.js';
import { Permission, hasPermission } from '../../roles/permissions.js';
import type { Actor } from '../../../common/schemas/user-snapshot.schema.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';

/** Plain fields copied 1:1 from the DTO; null clears the nullable ones. */
const SIMPLE_FIELDS = [
  'barcode',
  'salePrice',
  'purchasePrice',
  'vatRate',
  'minStock',
  'reorderLevel',
  'maxStock',
  'notes',
] as const;

/** Defaults for SIMPLE_FIELDS left out on create. */
const DEFAULTS: Record<(typeof SIMPLE_FIELDS)[number], number | null> = {
  barcode: null,
  salePrice: 0,
  purchasePrice: 0,
  vatRate: 5,
  minStock: null,
  reorderLevel: null,
  maxStock: null,
  notes: null,
};

type DisplayRecord = Record<string, string | number | null>;

const AUDITED_FIELDS: readonly DiffField<DisplayRecord>[] = [
  { key: 'name', label: 'Name' },
  { key: 'productGroup', label: 'Product group' },
  { key: 'type', label: 'Type' },
  { key: 'unit', label: 'Unit' },
  { key: 'barcode', label: 'Barcode' },
  { key: 'salePrice', label: 'Sale price' },
  { key: 'purchasePrice', label: 'Purchase price' },
  { key: 'vatRate', label: 'VAT %' },
  { key: 'minStock', label: 'Min stock' },
  { key: 'reorderLevel', label: 'Reorder level' },
  { key: 'maxStock', label: 'Max stock' },
  { key: 'status', label: 'Status' },
  { key: 'notes', label: 'Notes' },
];

export interface ProductView {
  id: string;
  code: string;
  name: string;
  productGroupId: string;
  productGroup: { id: string; code: string; name: string } | null;
  type: ProductType;
  unitId: string;
  unit: { id: string; name: string; symbol: string } | null;
  barcode: string | null;
  salePrice: number;
  /** Absent for users without products:view-cost (stripped by the controller). */
  purchasePrice?: number;
  vatRate: number;
  minStock: number | null;
  reorderLevel: number | null;
  maxStock: number | null;
  status: ProductStatus;
  /** Our FileAttachment id; download through `imageUrl`. */
  imageFileId: string | null;
  imageUrl: string | null;
  notes: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ProductPage {
  items: ProductView[];
  total: number;
  page: number;
  limit: number;
}

export interface ProductLookupItem {
  id: string;
  code: string;
  name: string;
  unit: { id: string; name: string; symbol: string } | null;
  salePrice: number;
  vatRate: number;
}

@Injectable()
export class ProductService {
  private readonly logger = new Logger(ProductService.name);

  constructor(
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(ProductGroup.name) private readonly productGroupModel: Model<ProductGroupDocument>,
    @InjectModel(Unit.name) private readonly unitModel: Model<UnitDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly sequenceService: SequenceService,
    private readonly filesService: FilesService,
    private readonly auditService: AuditService,
    private readonly usageRegistry: ProductUsageRegistry,
    entityAccess: EntityAccessRegistry,
  ) {
    // The timeline carries purchase price diffs, so it needs products:view-cost.
    entityAccess.register(PRODUCT_ENTITY_TYPE, {
      exists: async (id) => Boolean(await this.productModel.exists({ _id: id }).exec()),
      canRead: (user) => hasPermission(user, Permission.PRODUCTS_VIEW_COST),
    });
  }

  async list(query: ProductQueryDto): Promise<ProductPage> {
    const filter: QueryFilter<ProductDocument> = { ...this.searchFilter(query.q, ['name', 'code', 'barcode']) };
    if (query.groupId) filter.productGroupId = { $in: await this.groupWithDescendants(query.groupId) };
    if (query.type) filter.type = query.type;
    if (query.status) filter.status = query.status;

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [items, total] = await Promise.all([
      this.productModel
        .find(filter)
        .sort({ code: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.productModel.countDocuments(filter).exec(),
    ]);
    return { items: await this.toViews(items), total, page, limit };
  }

  /** Active products for invoice dropdowns. */
  async lookup(query: ProductLookupQueryDto): Promise<ProductLookupItem[]> {
    const filter: QueryFilter<ProductDocument> = {
      ...this.searchFilter(query.q, ['name', 'code', 'barcode']),
      status: ProductStatus.ACTIVE,
    };
    if (query.groupId) filter.productGroupId = { $in: await this.groupWithDescendants(query.groupId) };
    if (query.type) filter.type = query.type;

    const products = await this.productModel
      .find(filter)
      .select('code name unitId salePrice vatRate')
      .sort({ name: 1 })
      .limit(query.limit ?? 50)
      .lean()
      .exec();
    const units = await this.unitsById(products.map((product) => product.unitId));

    return products.map((product) => ({
      id: product._id.toString(),
      code: product.code,
      name: product.name,
      unit: units.get(product.unitId.toString()) ?? null,
      salePrice: product.salePrice,
      vatRate: product.vatRate,
    }));
  }

  async findById(id: string): Promise<ProductView> {
    return (await this.toViews([await this.getByIdOrThrow(id)]))[0];
  }

  /** For later modules (stock, invoices, bundles) that block on product references. */
  async isProductUsed(id: Types.ObjectId, session?: ClientSession): Promise<boolean> {
    return this.usageRegistry.isProductUsed(id, session);
  }

  async create(dto: CreateProductDto, actor: Actor): Promise<ProductView> {
    await this.assertGroupExists(dto.productGroupId);
    await this.assertUnitExists(dto.unitId);
    const values = Object.fromEntries(SIMPLE_FIELDS.map((field) => [field, dto[field] ?? DEFAULTS[field]]));
    this.assertStockLevels(values.minStock as number | null, values.reorderLevel as number | null, values.maxStock as number | null);

    const created = await this.inTransaction(async (session) => {
      await this.assertNoDuplicates(dto.name, (values.barcode as string | null) ?? null, null, session);
      const code = await this.sequenceService.nextCode(PRODUCT_CODE_SEQUENCE, session);
      const [product] = await this.productModel.create(
        [
          {
            code,
            name: dto.name,
            productGroupId: new Types.ObjectId(dto.productGroupId),
            type: dto.type,
            unitId: new Types.ObjectId(dto.unitId),
            status: dto.status ?? ProductStatus.ACTIVE,
            imageFileRef: null,
            ...values,
          },
        ],
        { session },
      );
      await this.auditService.record(
        { entityType: PRODUCT_ENTITY_TYPE, entityId: product._id, entityRef: code, action: AuditAction.CREATED, actor },
        session,
      );
      return product;
    });

    return this.findById(created.id);
  }

  /**
   * Also how a product is deactivated or reactivated (status). Records a field
   * diff (prices included); rejects with "No changes to save" when nothing changes.
   */
  async update(id: string, dto: UpdateProductDto, actor: Actor): Promise<ProductView> {
    const provided = (key: keyof UpdateProductDto) => Object.prototype.hasOwnProperty.call(dto, key);
    if (provided('name') && !dto.name) throw new BadRequestException('name cannot be empty');
    if (provided('productGroupId')) await this.assertGroupExists(dto.productGroupId!);
    if (provided('unitId')) await this.assertUnitExists(dto.unitId!);

    await this.inTransaction(async (session) => {
      const product = await this.getByIdOrThrow(id, session);
      const before = await this.display(product);

      if (provided('name')) product.name = dto.name!;
      if (provided('productGroupId')) product.productGroupId = new Types.ObjectId(dto.productGroupId!);
      if (provided('type') && dto.type !== product.type) {
        const usedBy = await this.usageRegistry.findUsage(product._id, session);
        if (usedBy) {
          throw new BadRequestException(`The type of ${product.code} cannot change: it is used by ${usedBy}`);
        }
        product.type = dto.type!;
      }
      if (provided('unitId')) product.unitId = new Types.ObjectId(dto.unitId!);
      if (provided('status')) product.status = dto.status!;
      for (const field of SIMPLE_FIELDS) {
        if (provided(field)) product.set(field, dto[field] ?? DEFAULTS[field]);
      }
      this.assertStockLevels(product.minStock, product.reorderLevel, product.maxStock);

      const changes = diffFields(before, await this.display(product), AUDITED_FIELDS);
      if (changes.length === 0) {
        throw new BadRequestException('No changes to save');
      }
      if (changes.some((change) => change.field === 'name' || change.field === 'barcode')) {
        await this.assertNoDuplicates(product.name, product.barcode, product._id, session);
      }

      await product.save({ session });
      await this.auditService.record(
        {
          entityType: PRODUCT_ENTITY_TYPE,
          entityId: product._id,
          entityRef: product.code,
          action: changes.some((change) => change.field === 'status' && change.to === ProductStatus.INACTIVE)
            ? AuditAction.DEACTIVATED
            : AuditAction.UPDATED,
          actor,
          changes,
        },
        session,
      );
    });

    return this.findById(id);
  }

  /** Only a product nothing references; otherwise deactivate. Its image is removed from storage afterwards. */
  async remove(id: string): Promise<{ success: true }> {
    const imageFileRef = await this.inTransaction(async (session) => {
      const product = await this.getByIdOrThrow(id, session);
      const usedBy = await this.usageRegistry.findUsage(product._id, session);
      if (usedBy) {
        throw new ConflictException(
          `Cannot delete product ${product.code} (${product.name}): it is used by ${usedBy}. Deactivate it instead.`,
        );
      }
      await this.productModel.deleteOne({ _id: product._id }, { session }).exec();
      return product.imageFileRef?.toString() ?? null;
    });

    if (imageFileRef) await this.removeFileQuietly(imageFileRef);
    return { success: true };
  }

  /** Stores the image through the /files module and replaces any previous one. */
  async setImage(id: string, file: Express.Multer.File | undefined, actor: Actor): Promise<ProductView> {
    await this.getByIdOrThrow(id);
    if (file && !file.mimetype.startsWith('image/')) {
      throw new BadRequestException('The product image must be an image file');
    }
    const stored = await this.filesService.upload(file, { ownerType: FileOwnerType.PRODUCT, ownerId: id }, actor.id);

    let previous: string | null;
    try {
      previous = await this.inTransaction(async (session) => {
        const product = await this.getByIdOrThrow(id, session);
        const old = product.imageFileRef?.toString() ?? null;
        product.imageFileRef = new Types.ObjectId(stored.id);
        await product.save({ session });
        await this.recordImageChange(
          product,
          { field: 'image', label: old ? 'Image replaced' : 'Image added', from: null, to: stored.originalName },
          actor,
          session,
        );
        return old;
      });
    } catch (error) {
      await this.removeFileQuietly(stored.id);
      throw error;
    }

    if (previous) await this.removeFileQuietly(previous);
    return this.findById(id);
  }

  async removeImage(id: string, actor: Actor): Promise<ProductView> {
    const fileRef = await this.inTransaction(async (session) => {
      const product = await this.getByIdOrThrow(id, session);
      if (!product.imageFileRef) {
        throw new NotFoundException(`${product.code} has no image`);
      }
      const old = product.imageFileRef.toString();
      product.imageFileRef = null;
      await product.save({ session });
      await this.recordImageChange(product, { field: 'image', label: 'Image removed', from: null, to: null }, actor, session);
      return old;
    });

    // After the commit: the product no longer points at the file.
    await this.removeFileQuietly(fileRef);
    return this.findById(id);
  }

  private async recordImageChange(
    product: ProductDocument,
    change: AuditChange,
    actor: Actor,
    session: ClientSession,
  ): Promise<void> {
    await this.auditService.record(
      {
        entityType: PRODUCT_ENTITY_TYPE,
        entityId: product._id,
        entityRef: product.code,
        action: AuditAction.UPDATED,
        actor,
        changes: [change],
      },
      session,
    );
  }

  private async removeFileQuietly(fileId: string): Promise<void> {
    await this.filesService.remove(fileId).catch((error: unknown) => {
      this.logger.warn(`Could not remove file ${fileId}: ${(error as Error).message}`);
    });
  }

  private async getByIdOrThrow(id: string, session?: ClientSession): Promise<ProductDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Product id "${id}" is not a valid id`);
    }
    const product = await this.productModel
      .findById(id)
      .session(session ?? null)
      .exec();
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return product;
  }

  private async assertGroupExists(id: string): Promise<void> {
    if (!(await this.productGroupModel.exists({ _id: id }).exec())) {
      throw new BadRequestException(`Product group ${id} not found`);
    }
  }

  private async assertUnitExists(id: string): Promise<void> {
    if (!(await this.unitModel.exists({ _id: id }).exec())) {
      throw new BadRequestException(`Unit ${id} not found`);
    }
  }

  /** Each level that is set must not exceed the next one that is set: min <= reorder <= max. */
  private assertStockLevels(min: number | null, reorder: number | null, max: number | null): void {
    if (min != null && reorder != null && min > reorder) {
      throw new BadRequestException('minStock cannot be more than reorderLevel');
    }
    if (reorder != null && max != null && reorder > max) {
      throw new BadRequestException('reorderLevel cannot be more than maxStock');
    }
    if (min != null && max != null && min > max) {
      throw new BadRequestException('minStock cannot be more than maxStock');
    }
  }

  /** Same name (ignoring case) or same barcode on any other product. */
  private async assertNoDuplicates(
    name: string,
    barcode: string | null,
    exceptId: Types.ObjectId | null,
    session: ClientSession,
  ): Promise<void> {
    const others = exceptId ? { _id: { $ne: exceptId } } : {};
    const sameName = await this.productModel
      .findOne({ ...others, name: name.trim() })
      .collation(PRODUCT_NAME_COLLATION)
      .session(session)
      .exec();
    if (sameName) {
      throw new ConflictException(`A product named "${sameName.name}" already exists (${sameName.code})`);
    }
    if (barcode) {
      const sameBarcode = await this.productModel
        .findOne({ ...others, barcode })
        .session(session)
        .exec();
      if (sameBarcode) {
        throw new ConflictException(`Barcode ${barcode} is already used by ${sameBarcode.code} (${sameBarcode.name})`);
      }
    }
  }

  /** The group id plus every group below it (groups nest through `under`). */
  async groupWithDescendants(groupId: string): Promise<Types.ObjectId[]> {
    const groups = await this.productGroupModel.find().select('under').lean().exec();
    const children = new Map<string, string[]>();
    for (const group of groups) {
      const parent = group.under?.toString();
      if (parent) children.set(parent, [...(children.get(parent) ?? []), group._id.toString()]);
    }
    const result = new Set<string>([groupId]);
    const queue = [groupId];
    while (queue.length > 0) {
      for (const child of children.get(queue.shift()!) ?? []) {
        if (!result.has(child)) {
          result.add(child);
          queue.push(child);
        }
      }
    }
    return [...result].map((id) => new Types.ObjectId(id));
  }

  private async unitsById(ids: Types.ObjectId[]): Promise<Map<string, { id: string; name: string; symbol: string }>> {
    const units = await this.unitModel.find({ _id: { $in: ids } }).select('name symbol').lean().exec();
    return new Map(units.map((unit) => [unit._id.toString(), { id: unit._id.toString(), name: unit.name, symbol: unit.symbol }]));
  }

  private async groupsById(ids: Types.ObjectId[]): Promise<Map<string, { id: string; code: string; name: string }>> {
    const groups = await this.productGroupModel.find({ _id: { $in: ids } }).select('code name').lean().exec();
    return new Map(groups.map((group) => [group._id.toString(), { id: group._id.toString(), code: group.code, name: group.name }]));
  }

  /** Audited fields as plain values; group and unit by name, not id. */
  private async display(product: ProductDocument): Promise<DisplayRecord> {
    const [groups, units] = await Promise.all([
      this.groupsById([product.productGroupId]),
      this.unitsById([product.unitId]),
    ]);
    const record: DisplayRecord = {
      name: product.name,
      productGroup: groups.get(product.productGroupId.toString())?.name ?? product.productGroupId.toString(),
      type: product.type,
      unit: units.get(product.unitId.toString())?.symbol ?? product.unitId.toString(),
      status: product.status,
    };
    for (const field of SIMPLE_FIELDS) {
      record[field] = (product.get(field) as string | number | null) ?? null;
    }
    return record;
  }

  private async toViews(products: ProductDocument[]): Promise<ProductView[]> {
    const [groups, units] = await Promise.all([
      this.groupsById(products.map((product) => product.productGroupId)),
      this.unitsById(products.map((product) => product.unitId)),
    ]);
    return products.map((product) => {
      const imageFileId = product.imageFileRef?.toString() ?? null;
      return {
        id: product._id.toString(),
        code: product.code,
        name: product.name,
        productGroupId: product.productGroupId.toString(),
        productGroup: groups.get(product.productGroupId.toString()) ?? null,
        type: product.type,
        unitId: product.unitId.toString(),
        unit: units.get(product.unitId.toString()) ?? null,
        barcode: product.barcode,
        salePrice: product.salePrice,
        purchasePrice: product.purchasePrice,
        vatRate: product.vatRate,
        minStock: product.minStock,
        reorderLevel: product.reorderLevel,
        maxStock: product.maxStock,
        status: product.status,
        imageFileId,
        imageUrl: imageFileId ? `/files/${imageFileId}` : null,
        notes: product.notes,
        createdAt: (product as unknown as { createdAt?: Date }).createdAt,
        updatedAt: (product as unknown as { updatedAt?: Date }).updatedAt,
      };
    });
  }

  private searchFilter(q: string | undefined, fields: string[]): QueryFilter<ProductDocument> {
    const term = q?.trim();
    if (!term) {
      return {};
    }
    const pattern = new RegExp(escapeRegExp(term), 'i');
    return { $or: fields.map((field) => ({ [field]: pattern })) };
  }

  private async inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    try {
      return await runInTransaction(this.connection, work);
    } catch (error) {
      throw this.toFriendlyError(error);
    }
  }

  /** Backstop for races the pre-checks can't see: the unique indexes reject the second writer. */
  private toFriendlyError(error: unknown): unknown {
    const duplicate = error as { code?: number; keyPattern?: Record<string, unknown> };
    if (duplicate?.code !== 11000) return error;
    if (duplicate.keyPattern?.barcode) return new ConflictException('A product with this barcode already exists');
    if (duplicate.keyPattern?.name) return new ConflictException('A product with this name already exists');
    if (duplicate.keyPattern?.code) {
      return new ConflictException(
        'Generated product code is already in use; the code counter is behind existing data and needs re-syncing (pnpm migrate:code-sequences)',
      );
    }
    return error;
  }
}
