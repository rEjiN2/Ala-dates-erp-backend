import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { LedgerAccount } from '../../ledger-accounts/schemas/ledger-account.schema.js';
import { VoucherBase, applyVoucherIndexes } from '../../vouchers/schemas/voucher.schema.js';

export type CashHandoverDocument = HydratedDocument<CashHandover>;

/** Entity type under which handovers appear in audit logs, comments, the activity timeline and ledger entries. */
export const CASH_HANDOVER_ENTITY_TYPE = 'cash-handover';

/**
 * Money moved from one of the company's cash/wallet/bank accounts to another,
 * from one cashier to another (e.g. a van salesman handing the day's cash to
 * the office). Stored as a voucher (see VoucherBase) so it posts, edits,
 * cancels and prints like the others:
 * - cashierId / cashierName: the cashier handing over ("handed by");
 * - fromAccountId: the header account, credited;
 * - lines[0].accountId: the account received into, debited; there is always
 *   exactly one line, and grandTotal is the amount.
 */
@Schema({ collection: 'cash_handovers', toJSON: { virtuals: true }, toObject: { virtuals: true } })
export class CashHandover extends VoucherBase {
  /** An active cash, wallet or bank account; credited. */
  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, required: true, index: true })
  fromAccountId: Types.ObjectId;

  /** The cashier who received the money. */
  @Prop({ type: Types.ObjectId, ref: 'Cashier', required: true, index: true })
  receivedByCashierId: Types.ObjectId;

  /** Their name when set on this handover. Historical snapshot, not refreshed on rename. */
  @Prop({ type: String, trim: true, required: true })
  receivedByCashierName: string;
}

export const CashHandoverSchema = SchemaFactory.createForClass(CashHandover);
applyVoucherIndexes(CashHandoverSchema);

// API names for the generic voucher fields.
CashHandoverSchema.virtual('handedByCashierId').get(function (this: CashHandover) {
  return this.cashierId;
});
CashHandoverSchema.virtual('handedByCashierName').get(function (this: CashHandover) {
  return this.cashierName;
});
CashHandoverSchema.virtual('toAccountId').get(function (this: CashHandover) {
  return this.lines?.[0]?.accountId ?? null;
});
CashHandoverSchema.virtual('amount').get(function (this: CashHandover) {
  return this.grandTotal;
});
