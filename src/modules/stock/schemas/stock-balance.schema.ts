import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type StockBalanceDocument = HydratedDocument<StockBalance>;

/** Running quantity of one product at one location. Only ever moved by StockService.post. */
@Schema({ collection: 'stock_balances', versionKey: false })
export class StockBalance {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Location', required: true, index: true })
  locationId: Types.ObjectId;

  @Prop({ required: true, default: 0 })
  qty: number;
}

export const StockBalanceSchema = SchemaFactory.createForClass(StockBalance);
StockBalanceSchema.index({ productId: 1, locationId: 1 }, { unique: true });
