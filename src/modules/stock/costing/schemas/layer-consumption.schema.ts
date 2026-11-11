import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type LayerConsumptionDocument = HydratedDocument<LayerConsumption>;

/**
 * What a voucher line took from a cost layer. Rows are never deleted: a
 * reversal only stamps reversedAt (a partial restore also shrinks the row to
 * the part put back and inserts one for the part that stays consumed). layerId is null for
 * an uncosted shortfall (stock sold with no layer left to cost it).
 */
@Schema({ collection: 'layer_consumptions', versionKey: false })
export class LayerConsumption {
  @Prop({ type: Types.ObjectId, ref: 'CostLayer', default: null })
  layerId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ required: true })
  voucherType: string;

  @Prop({ type: Types.ObjectId, required: true })
  voucherId: Types.ObjectId;

  @Prop({ required: true })
  voucherNo: string;

  @Prop({ type: Types.ObjectId, default: null })
  lineId: Types.ObjectId | null;

  @Prop({ required: true })
  qty: number;

  @Prop({ required: true, min: 0 })
  unitCost: number;

  @Prop({ default: false })
  uncosted: boolean;

  @Prop({ required: true })
  createdAt: Date;

  @Prop({ type: Date, default: null })
  reversedAt: Date | null;

  /** Set when a voucher (a sales return) put this back into the layer, so cancelling that voucher can take it out again. */
  @Prop({ type: String, default: null })
  reversedByType: string | null;

  @Prop({ type: Types.ObjectId, default: null })
  reversedById: Types.ObjectId | null;
}

export const LayerConsumptionSchema = SchemaFactory.createForClass(LayerConsumption);
LayerConsumptionSchema.index({ voucherType: 1, voucherId: 1 });
LayerConsumptionSchema.index({ layerId: 1 });
LayerConsumptionSchema.index({ reversedByType: 1, reversedById: 1 });
