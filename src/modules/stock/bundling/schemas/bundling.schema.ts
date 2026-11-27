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

/** A batch-total cost on top of the parts (Labour, Transport, Other or free text). */
@Schema({ _id: false })
export class BundlingExtraCost {
  @Prop({ required: true, trim: true })
  label: string;

  @Prop({ required: true, min: 0 })
  amount: number;
}

export const BundlingExtraCostSchema = SchemaFactory.createForClass(BundlingExtraCost);

/**
 * Bundle (BND-0001) or unbundle (UBD-0001) at one location. No ledger posting,
 * only stock entries. Edit = reverse + repost under the same number; cancel
 * reverses the entries (both refused if any balance would go below zero, e.g.
 * the boxes were already sold).
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

  /** Batch totals (not per unit), added to the parts cost before dividing by qty. */
  @Prop({ type: [BundlingExtraCostSchema], default: [] })
  extraCosts: BundlingExtraCost[];

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
