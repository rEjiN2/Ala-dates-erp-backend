import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import type { Schema as MongooseSchema } from 'mongoose';
import { VoucherStatus } from '../../vouchers/schemas/voucher.schema.js';
import { UserSnapshot, UserSnapshotSchema } from '../../../../common/schemas/user-snapshot.schema.js';

/** Entity types under which returns appear in audit logs, comments, the activity timeline, ledger, stock and allocations. */
export const SALES_RETURN_ENTITY_TYPE = 'sales-return';
export const PURCHASE_RETURN_ENTITY_TYPE = 'purchase-return';

/** Credit documents that settle an invoice through an allocation: that credit counts as "credited", not "paid". */
export const CREDIT_NOTE_TYPES: readonly string[] = [SALES_RETURN_ENTITY_TYPE, PURCHASE_RETURN_ENTITY_TYPE];

/** One invoice line (part of it) returned. Rate, discount and VAT are the invoice line's, pro-rata. */
@Schema({ _id: false })
export class ReturnLine {
  /** The invoice line's _id. */
  @Prop({ type: Types.ObjectId, required: true })
  invoiceLineId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ required: true })
  qty: number;

  /** Sales returns: whether the goods go back into stock. Always true on purchase returns (they leave stock). */
  @Prop({ required: true, default: true })
  restock: boolean;

  /** The invoice line's rate. */
  @Prop({ required: true })
  rate: number;

  /** Pro-rata share of the invoice line's discount. */
  @Prop({ required: true, default: 0 })
  discount: number;

  /** Pro-rata net before VAT. */
  @Prop({ required: true })
  amount: number;

  @Prop({ required: true })
  vatRate: number;

  @Prop({ required: true })
  vat: number;

  /** amount + vat. */
  @Prop({ required: true })
  netAmount: number;

  /** Stock unit cost: the sale's cost snapshot, or the purchase's net rate. */
  @Prop({ required: true, default: 0 })
  unitCost: number;
}

export const ReturnLineSchema = SchemaFactory.createForClass(ReturnLine);

/**
 * A credit note (SR-0001) or debit note (PR-0001) against one invoice. Fields
 * every return shares; each kind adds only its collection. Sales: Dr Sales
 * Returns + VAT Output, Cr customer, stock back in. Purchase: Dr supplier, Cr
 * Purchase Returns + VAT Input, stock out. The credit is applied to the
 * original invoice up to its balance (autoAllocationId); the rest stays on account.
 */
export abstract class ReturnBase {
  @Prop({ required: true, unique: true, trim: true })
  voucherNo: string;

  @Prop({ required: true, index: true })
  voucherDate: Date;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  invoiceId: Types.ObjectId;

  @Prop({ required: true })
  invoiceNo: string;

  /** The customer or supplier. */
  @Prop({ type: Types.ObjectId, ref: 'Party', required: true, index: true })
  partyId: Types.ObjectId;

  /** The party's ledger account at the time of posting. */
  @Prop({ type: Types.ObjectId, ref: 'LedgerAccount', required: true, index: true })
  partyAccountId: Types.ObjectId;

  /** Where the goods go back in (sales) or come out of (purchase). */
  @Prop({ type: Types.ObjectId, ref: 'Location', required: true, index: true })
  locationId: Types.ObjectId;

  /** Sales returns: the invoice's salesman, so they still see the return. */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null, index: true })
  soldById: Types.ObjectId | null;

  @Prop({ required: true, trim: true })
  reason: string;

  @Prop({ type: [ReturnLineSchema], required: true, default: [] })
  lines: ReturnLine[];

  /** Net before VAT: the contra account's side. */
  @Prop({ required: true, default: 0 })
  taxableTotal: number;

  @Prop({ required: true, default: 0 })
  totalTax: number;

  /** The party's side. */
  @Prop({ required: true, default: 0 })
  netTotal: number;

  /** The allocation made when the return was saved; edit and cancel are allowed only while it is the only active one. */
  @Prop({ type: Types.ObjectId, default: null })
  autoAllocationId: Types.ObjectId | null;

  @Prop({ type: String, enum: [VoucherStatus.POSTED, VoucherStatus.CANCELLED], default: VoucherStatus.POSTED, index: true })
  status: VoucherStatus;

  @Prop({ default: 0 })
  printCount: number;

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

export type ReturnDocument = HydratedDocument<ReturnBase>;

@Schema({ collection: 'sales_returns', versionKey: false })
export class SalesReturn extends ReturnBase {}

@Schema({ collection: 'purchase_returns', versionKey: false })
export class PurchaseReturn extends ReturnBase {}

export const SalesReturnSchema = SchemaFactory.createForClass(SalesReturn);
export const PurchaseReturnSchema = SchemaFactory.createForClass(PurchaseReturn);

/** Indexes both return collections need, beyond the per-field ones above. */
function applyReturnIndexes(schema: MongooseSchema): void {
  schema.index({ 'lines.productId': 1 });
  schema.index({ 'createdBy.id': 1 });
}
applyReturnIndexes(SalesReturnSchema);
applyReturnIndexes(PurchaseReturnSchema);
