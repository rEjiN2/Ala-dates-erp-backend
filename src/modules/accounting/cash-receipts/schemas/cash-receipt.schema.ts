import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { LedgerAccount } from '../../ledger-accounts/schemas/ledger-account.schema.js';

export type CashReceiptDocument = HydratedDocument<CashReceipt>;

@Schema({ _id: false })
export class CashReceiptLine {
  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, required: true })
  accountId: Types.ObjectId;

  @Prop({ trim: true })
  narration?: string;

  @Prop({ trim: true })
  remarks?: string;

  /** Balance of accountId at the moment this voucher was posted. Historical snapshot, never recomputed. */
  @Prop({ required: true, default: 0 })
  oldBalance: number;

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true, default: 0 })
  vat: number;

  @Prop({ required: true })
  netAmount: number;
}

export const CashReceiptLineSchema = SchemaFactory.createForClass(CashReceiptLine);

@Schema({ timestamps: true, collection: 'cash_receipts' })
export class CashReceipt {
  @Prop({ required: true, unique: true, trim: true })
  voucherNo: string;

  @Prop({ required: true, index: true })
  voucherDate: Date;

  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, required: true, index: true })
  cashAccountId: Types.ObjectId;

  @Prop({ trim: true })
  cashier?: string;

  @Prop({ trim: true })
  comments?: string;

  @Prop({ type: [CashReceiptLineSchema], required: true, default: [] })
  lines: CashReceiptLine[];

  @Prop({ required: true, default: 0 })
  grossTotal: number;

  @Prop({ required: true, default: 0 })
  totalTax: number;

  @Prop({ required: true, default: 0 })
  grandTotal: number;
}

export const CashReceiptSchema = SchemaFactory.createForClass(CashReceipt);

// Backs the "is this ledger account used?" check that guards account deletion.
CashReceiptSchema.index({ 'lines.accountId': 1 });
