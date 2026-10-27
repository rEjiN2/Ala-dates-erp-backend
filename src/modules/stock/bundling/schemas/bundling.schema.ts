import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { VoucherStatus } from '../../../accounting/vouchers/schemas/voucher.schema.js';
import { UserSnapshot, UserSnapshotSchema } from '../../../../common/schemas/user-snapshot.schema.js';

export type BundlingDocument = HydratedDocument<Bundling>;

/** Entity type under which bundlings appear in audit logs, comments and stock entries. */
export const BUNDLING_ENTITY_TYPE = 'bundling';

export enum BundlingMode {
  BUNDLE = 'bundle',
  UNBUNDLE = 'unbundle',
}

/** The recipe as it was when the bundling was posted; later recipe changes don't alter it. */
@Schema({ _id: false })
export class RecipeSnapshotLine {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  /** Per one bundle. */
  @Prop({ required: true })
  qty: number;

  /** The component's purchase price at the time. */
  @Prop({ required: true, default: 0 })
  unitCost: number;
}

export const RecipeSnapshotLineSchema = SchemaFactory.createForClass(RecipeSnapshotLine);

@Schema({ _id: false })
export class RecipeSnapshot {
  @Prop({ required: true })
  version: number;

  @Prop({ required: true, default: 0 })
  extraCostPerUnit: number;

  @Prop({ type: [RecipeSnapshotLineSchema], required: true, default: [] })
  components: RecipeSnapshotLine[];
}

export const RecipeSnapshotSchema = SchemaFactory.createForClass(RecipeSnapshot);

/**
 * Bundle or unbundle at one location (BND-0001). No ledger posting, only stock
 * entries. No edit; cancel reverses the entries (refused if any balance would
 * go below zero, e.g. the boxes were already sold).
 */
@Schema({ collection: 'bundlings', versionKey: false })
export class Bundling {
  @Prop({ required: true, unique: true, trim: true })
  voucherNo: string;

  @Prop({ required: true, index: true })
  date: Date;

  @Prop({ type: Types.ObjectId, ref: 'Location', required: true, index: true })
  locationId: Types.ObjectId;

  @Prop({ type: String, enum: BundlingMode, required: true, index: true })
  mode: BundlingMode;

  @Prop({ type: Types.ObjectId, ref: 'Product', required: true, index: true })
  bundleProductId: Types.ObjectId;

  @Prop({ required: true })
  qty: number;

  @Prop({ required: true, default: true })
  updateBundlePurchasePrice: boolean;

  @Prop({ trim: true })
  remarks?: string;

  @Prop({ type: RecipeSnapshotSchema, required: true })
  recipeSnapshot: RecipeSnapshot;

  @Prop({ required: true, default: 0 })
  costPerUnit: number;

  @Prop({ type: String, enum: [VoucherStatus.POSTED, VoucherStatus.CANCELLED], default: VoucherStatus.POSTED, index: true })
  status: VoucherStatus;

  @Prop({ required: true, default: 0 })
  printCount: number;

  @Prop({ type: UserSnapshotSchema, default: null })
  createdBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  createdAt: Date | null;

  @Prop({ type: UserSnapshotSchema, default: null })
  cancelledBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  cancelledAt: Date | null;

  @Prop({ type: String, trim: true, default: null })
  cancelReason: string | null;
}

export const BundlingSchema = SchemaFactory.createForClass(Bundling);
