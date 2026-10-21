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

/** Shared voucher fields (see VoucherBase) plus the account the money is received into. */
@Schema({ collection: 'cash_receipts' })
export class CashReceipt extends VoucherBase {
  /** "Received into": an active cash, wallet or bank account (named from when only cash was allowed). */
  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, required: true, index: true })
  cashAccountId: Types.ObjectId;
}

export const CashReceiptSchema = SchemaFactory.createForClass(CashReceipt);
applyVoucherIndexes(CashReceiptSchema);
