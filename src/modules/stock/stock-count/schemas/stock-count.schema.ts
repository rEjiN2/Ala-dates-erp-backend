import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { UserSnapshot, UserSnapshotSchema } from '../../../../common/schemas/user-snapshot.schema.js';

export type StockCountDocument = HydratedDocument<StockCount>;

/** Entity type under which stock counts appear in audit logs, comments, the activity timeline and stock entries. */
export const STOCK_COUNT_ENTITY_TYPE = 'stock-count';

export enum StockCountStatus {
  DRAFT = 'draft',
  SUBMITTED = 'submitted',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
}

@Schema({ _id: false })
export class StockCountLine {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  /** The system quantity when the product was added to the count. */
  @Prop({ required: true })
  snapshotQty: number;

  /** Null until counted; every line must be counted to submit. */
  @Prop({ type: Number, default: null })
  countedQty: number | null;

  @Prop({ type: String, trim: true, default: null })
  reason: string | null;

  /** Set on approval: the balance differed from snapshotQty at that moment. */
  @Prop({ type: Boolean, default: false })
  movedSinceCount: boolean;
}

export const StockCountLineSchema = SchemaFactory.createForClass(StockCountLine);

/**
 * A physical count at one location (SC-0001). Approval posts countedQty minus
 * snapshotQty per line as stock entries; nothing posts to the ledger.
 * Cancelling an approved count reverses them; no delete.
 */
@Schema({ collection: 'stock_counts', versionKey: false })
export class StockCount {
  @Prop({ required: true, unique: true, trim: true })
  voucherNo: string;

  @Prop({ required: true, index: true })
  date: Date;

  @Prop({ type: Types.ObjectId, ref: 'Location', required: true, index: true })
  locationId: Types.ObjectId;

  @Prop({ trim: true })
  comments?: string;

  @Prop({ type: String, enum: StockCountStatus, default: StockCountStatus.DRAFT, index: true })
  status: StockCountStatus;

  @Prop({ type: [StockCountLineSchema], default: [] })
  lines: StockCountLine[];

  /** When the latest snapshot quantity was taken. */
  @Prop({ required: true })
  snapshotAt: Date;

  @Prop({ type: UserSnapshotSchema, default: null })
  createdBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  createdAt: Date | null;

  @Prop({ type: UserSnapshotSchema, default: null })
  updatedBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  updatedAt: Date | null;

  @Prop({ type: UserSnapshotSchema, default: null })
  submittedBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  submittedAt: Date | null;

  @Prop({ type: UserSnapshotSchema, default: null })
  approvedBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  approvedAt: Date | null;

  @Prop({ type: UserSnapshotSchema, default: null })
  rejectedBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  rejectedAt: Date | null;

  @Prop({ type: String, trim: true, default: null })
  rejectReason: string | null;

  @Prop({ type: UserSnapshotSchema, default: null })
  cancelledBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  cancelledAt: Date | null;

  @Prop({ type: String, trim: true, default: null })
  cancelReason: string | null;

  @Prop({ type: Number, default: 0 })
  printCount: number;
}

export const StockCountSchema = SchemaFactory.createForClass(StockCount);
