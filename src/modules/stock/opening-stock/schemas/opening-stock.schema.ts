import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { VoucherStatus } from '../../../accounting/vouchers/schemas/voucher.schema.js';
import { UserSnapshot, UserSnapshotSchema } from '../../../../common/schemas/user-snapshot.schema.js';

export type OpeningStockDocument = HydratedDocument<OpeningStock>;

/** Entity type under which opening stock appears in audit logs, comments, the activity timeline and stock entries. */
export const OPENING_STOCK_ENTITY_TYPE = 'opening-stock';

@Schema({ _id: false })
export class OpeningStockLine {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ required: true })
  qty: number;

  @Prop({ type: Number, default: null })
  unitCost: number | null;
}

export const OpeningStockLineSchema = SchemaFactory.createForClass(OpeningStockLine);

/**
 * Opening stock at one location as of a date (OS-0001): one stock entry per
 * line. A product has at most one non-cancelled opening line per location.
 * Edit = reverse + repost; cancel reverses (refused if any balance would go
 * below zero); no delete.
 */
@Schema({ collection: 'opening_stocks', versionKey: false })
export class OpeningStock {
  @Prop({ required: true, unique: true, trim: true })
  voucherNo: string;

  @Prop({ required: true, index: true })
  asOfDate: Date;

  @Prop({ type: Types.ObjectId, ref: 'Location', required: true, index: true })
  locationId: Types.ObjectId;

  @Prop({ trim: true })
  comments?: string;

  @Prop({ type: [OpeningStockLineSchema], required: true, default: [] })
  lines: OpeningStockLine[];

  @Prop({ required: true, default: 0 })
  totalQty: number;

  @Prop({ type: String, enum: [VoucherStatus.POSTED, VoucherStatus.CANCELLED], default: VoucherStatus.POSTED, index: true })
  status: VoucherStatus;

  @Prop({ type: UserSnapshotSchema, default: null })
  createdBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  createdAt: Date | null;

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
}

export const OpeningStockSchema = SchemaFactory.createForClass(OpeningStock);
OpeningStockSchema.index({ locationId: 1, 'lines.productId': 1 });
