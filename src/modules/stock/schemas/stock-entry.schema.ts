import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { UserSnapshot, UserSnapshotSchema } from '../../../common/schemas/user-snapshot.schema.js';
import { insertOnlyPlugin } from '../../../common/utils/insert-only.plugin.js';

export type StockEntryDocument = HydratedDocument<StockEntry>;

/**
 * One stock movement of one product at one location, written by
 * StockService.post in the same transaction as the StockBalance change it
 * explains. Append-only: an edit or cancel writes reversing rows
 * (reversalOf), so every balance == sum(qty) over its entries.
 */
@Schema({ collection: 'stock_entries', versionKey: false })
export class StockEntry {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Location', required: true })
  locationId: Types.ObjectId;

  /** Signed: in > 0, out < 0. */
  @Prop({ required: true })
  qty: number;

  /** The voucher's date (a reversal keeps the date of the row it undoes). */
  @Prop({ required: true })
  date: Date;

  /** The voucher's entity type, e.g. "opening-stock". */
  @Prop({ required: true })
  voucherType: string;

  @Prop({ type: Types.ObjectId, required: true })
  voucherId: Types.ObjectId;

  @Prop({ required: true })
  voucherNo: string;

  @Prop({ type: Number, default: null })
  unitCost: number | null;

  /** The entry this one undoes. */
  @Prop({ type: Types.ObjectId, default: null })
  reversalOf: Types.ObjectId | null;

  @Prop({ type: UserSnapshotSchema, default: null })
  by: UserSnapshot | null;

  @Prop({ required: true })
  postedAt: Date;
}

export const StockEntrySchema = SchemaFactory.createForClass(StockEntry);

// History, and the per product+location reconciliation.
StockEntrySchema.index({ productId: 1, locationId: 1, date: 1 });
// Everything one voucher posted.
StockEntrySchema.index({ voucherType: 1, voucherId: 1 });
StockEntrySchema.plugin(insertOnlyPlugin, { modelName: StockEntry.name });
