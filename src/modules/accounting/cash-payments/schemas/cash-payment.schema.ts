import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { LedgerAccount } from '../../ledger-accounts/schemas/ledger-account.schema.js';
import { VoucherBase, applyVoucherIndexes } from '../../vouchers/schemas/voucher.schema.js';

export type CashPaymentDocument = HydratedDocument<CashPayment>;

/** Entity type under which payments appear in audit logs, comments, the activity timeline and ledger entries. */
export const CASH_PAYMENT_ENTITY_TYPE = 'cash-payment';

/** Shared voucher fields (see VoucherBase) plus the account the money is paid from. */
@Schema({ collection: 'cash_payments' })
export class CashPayment extends VoucherBase {
  /** "Paid from": an active cash, wallet or bank account. */
  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, required: true, index: true })
  paidFromAccountId: Types.ObjectId;
}

export const CashPaymentSchema = SchemaFactory.createForClass(CashPayment);
applyVoucherIndexes(CashPaymentSchema);
