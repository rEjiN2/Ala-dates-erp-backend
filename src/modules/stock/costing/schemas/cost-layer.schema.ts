import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type CostLayerDocument = HydratedDocument<CostLayer>;

/**
 * One FIFO layer: a purchase line or opening-stock line that brought a
 * product in at a cost. Company-wide per product (locations and transfers
 * never touch layers). Only qtyRemaining (CostService.consume/restore) and
 * voidedAt (removeLayers) ever change.
 */
@Schema({ collection: 'cost_layers', versionKey: false })
export class CostLayer {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  /** The source voucher's entity type, e.g. "purchase-invoice". */
  @Prop({ required: true })
  sourceType: string;

  @Prop({ type: Types.ObjectId, required: true })
  sourceVoucherId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, default: null })
  sourceLineId: Types.ObjectId | null;

  /** FIFO order: the voucher's date, then createdAt. */
  @Prop({ required: true })
  date: Date;

  @Prop({ required: true })
  qtyIn: number;

  @Prop({ required: true })
  qtyRemaining: number;

  /** Per unit, before VAT. */
  @Prop({ required: true, min: 0 })
  unitCost: number;

  @Prop({ type: Date, default: null })
  expiryDate: Date | null;

  @Prop({ required: true })
  createdAt: Date;

  /** Set when the source voucher was edited or cancelled (only possible while unconsumed). */
  @Prop({ type: Date, default: null })
  voidedAt: Date | null;
}

export const CostLayerSchema = SchemaFactory.createForClass(CostLayer);
CostLayerSchema.index({ productId: 1, qtyRemaining: 1, date: 1, createdAt: 1 });
CostLayerSchema.index({ sourceType: 1, sourceVoucherId: 1 });
