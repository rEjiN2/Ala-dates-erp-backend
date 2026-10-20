import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { LedgerAccount } from '../../ledger-accounts/schemas/ledger-account.schema.js';
import {
  PaymentMethod,
  VoucherBase,
  VoucherLine,
  VoucherLineSchema,
  VoucherStatus,
  applyVoucherIndexes,
  paymentMethodFor,
} from '../../vouchers/schemas/voucher.schema.js';

export { PaymentMethod, paymentMethodFor };

export type CashReceiptDocument = HydratedDocument<CashReceipt>;

/** Entity type under which receipts appear in audit logs, comments, the activity timeline and ledger entries. */
export const CASH_RECEIPT_ENTITY_TYPE = 'cash-receipt';

export const CashReceiptStatus = VoucherStatus;
export type CashReceiptStatus = VoucherStatus;

export { VoucherLine as CashReceiptLine, VoucherLineSchema as CashReceiptLineSchema };

/** Where a receipt's money stands with the office. Server-set only. */
export enum SettlementStatus {
  /** Collected by staff who settle with the office, not yet on a handover. */
  UNSETTLED = 'unsettled',
  /** On a submitted handover awaiting approval: locked. */
  SUBMITTED = 'submitted',
  /** On an approved handover (or settled before handover approval existed): locked. */
  SETTLED = 'settled',
}

/** Shared voucher fields (see VoucherBase) plus the account the money is received into. */
@Schema({ collection: 'cash_receipts' })
export class CashReceipt extends VoucherBase {
  /** "Received into": an active cash, wallet or bank account (named from when only cash was allowed). */
  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, required: true, index: true })
  cashAccountId: Types.ObjectId;

  /** null when the collector does not settle with the office, or the receipt is cancelled. */
  @Prop({ type: String, enum: [...Object.values(SettlementStatus), null], default: null, index: true })
  settlementStatus: SettlementStatus | null;

  /** The handover it is submitted or settled on. */
  @Prop({ type: Types.ObjectId, ref: 'CashHandover', default: null, index: true })
  handoverId: Types.ObjectId | null;

  /** When its handover was approved; old receipts backfilled as settled use their voucher date. */
  @Prop({ type: Date, default: null })
  settledAt: Date | null;
}

export const CashReceiptSchema = SchemaFactory.createForClass(CashReceipt);
applyVoucherIndexes(CashReceiptSchema);
