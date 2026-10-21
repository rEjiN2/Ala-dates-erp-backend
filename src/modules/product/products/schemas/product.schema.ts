import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ProductDocument = HydratedDocument<Product>;

/** Entity type under which products appear in audit logs, comments and the activity timeline. */
export const PRODUCT_ENTITY_TYPE = 'product';

export enum ProductType {
  STOCK = 'stock',
  NON_STOCK = 'non_stock',
  BUNDLE = 'bundle',
}

export enum ProductStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/** Case-insensitive comparison for product names (index and queries must use the same one). */
export const PRODUCT_NAME_COLLATION = { locale: 'en', strength: 2 } as const;

@Schema({ timestamps: true, collection: 'products' })
export class Product {
  // PRD-0001, generated on create and never changed afterwards.
  @Prop({ required: true, unique: true, trim: true, uppercase: true, immutable: true })
  code: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: Types.ObjectId, ref: 'ProductGroup', required: true, index: true })
  productGroupId: Types.ObjectId;

  @Prop({ type: String, enum: ProductType, required: true, index: true })
  type: ProductType;

  @Prop({ type: Types.ObjectId, ref: 'Unit', required: true, index: true })
  unitId: Types.ObjectId;

  @Prop({ type: String, trim: true, default: null })
  barcode: string | null;

  @Prop({ type: Number, min: 0, default: 0 })
  salePrice: number;

  /** Cost; returned only to users with products:view-cost. */
  @Prop({ type: Number, min: 0, default: 0 })
  purchasePrice: number;

  /** Percent; 0 is a valid (zero-rated) rate. */
  @Prop({ type: Number, min: 0, max: 100, default: 5 })
  vatRate: number;

  // Stock levels drive alerts only; they never block a transaction.
  @Prop({ type: Number, min: 0, default: null })
  minStock: number | null;

  @Prop({ type: Number, min: 0, default: null })
  reorderLevel: number | null;

  @Prop({ type: Number, min: 0, default: null })
  maxStock: number | null;

  @Prop({ type: String, enum: ProductStatus, required: true, default: ProductStatus.ACTIVE, index: true })
  status: ProductStatus;

  /** A FileAttachment id from the /files module, never a storage key or link. */
  @Prop({ type: Types.ObjectId, ref: 'FileAttachment', default: null })
  imageFileRef: Types.ObjectId | null;

  @Prop({ type: String, trim: true, default: null })
  notes: string | null;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

// The service checks first for a clear message; these are the race-proof backstop.
ProductSchema.index({ name: 1 }, { name: 'uniq_product_name', unique: true, collation: PRODUCT_NAME_COLLATION });
ProductSchema.index(
  { barcode: 1 },
  { name: 'uniq_product_barcode', unique: true, partialFilterExpression: { barcode: { $type: 'string' } } },
);
