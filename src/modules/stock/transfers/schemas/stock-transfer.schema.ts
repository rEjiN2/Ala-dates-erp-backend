import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { PendingReceiptStatus } from '../../pending-receipt.js';
import { UserSnapshot, UserSnapshotSchema } from '../../../../common/schemas/user-snapshot.schema.js';

export type StockTransferDocument = HydratedDocument<StockTransfer>;

/** Entity type under which transfers appear in audit logs, comments, the activity timeline and stock entries. */
export const STOCK_TRANSFER_ENTITY_TYPE = 'stock-transfer';

@Schema({ _id: false })
export class StockTransferLine {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ required: true })
  qty: number;

  /** Set when received; null while in transit. */
  @Prop({ type: Number, default: null })
  receivedQty: number | null;
}

export const StockTransferLineSchema = SchemaFactory.createForClass(StockTransferLine);

/**
 * Stock moved between two locations in two steps (TR-0001). Sending posts
 * negative entries at the source (status in_transit); receiving posts the
 * received quantity at the destination and any shortfall back at the source.
 * Edit and cancel only while in transit; no delete.
 */
@Schema({ collection: 'stock_transfers', versionKey: false })
export class StockTransfer {
  @Prop({ required: true, unique: true, trim: true })
  voucherNo: string;

  @Prop({ required: true, index: true })
  date: Date;

  @Prop({ type: Types.ObjectId, ref: 'Location', required: true, index: true })
  fromLocationId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Location', required: true, index: true })
  toLocationId: Types.ObjectId;

  @Prop({ trim: true })
  comments?: string;

  @Prop({ type: [StockTransferLineSchema], required: true, default: [] })
  lines: StockTransferLine[];

  @Prop({ required: true, default: 0 })
  totalQty: number;

  @Prop({ type: String, enum: PendingReceiptStatus, default: PendingReceiptStatus.IN_TRANSIT, index: true })
  status: PendingReceiptStatus;

  @Prop({ type: UserSnapshotSchema, default: null })
  sentBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  sentAt: Date | null;

  @Prop({ type: UserSnapshotSchema, default: null })
  receivedBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  receivedAt: Date | null;

  @Prop({ type: String, trim: true, default: null })
  shortfallReason: string | null;

  @Prop({ type: UserSnapshotSchema, default: null })
  updatedBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  updatedAt: Date | null;

  @Prop({ type: UserSnapshotSchema, default: null })
  cancelledBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  cancelledAt: Date | null;

  @Prop({ type: String, trim: true, default: null })
  cancelReason: string | null;

  @Prop({ required: true, default: 0 })
  printCount: number;
}

export const StockTransferSchema = SchemaFactory.createForClass(StockTransfer);
StockTransferSchema.index({ 'lines.productId': 1 });
