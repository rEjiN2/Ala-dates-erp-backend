import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { LedgerAccount, LedgerAccountType } from '../../ledger-accounts/schemas/ledger-account.schema.js';
import { VoucherBase, applyVoucherIndexes } from '../../vouchers/schemas/voucher.schema.js';
import { UserSnapshot, UserSnapshotSchema } from '../../../../common/schemas/user-snapshot.schema.js';

export type CashHandoverDocument = HydratedDocument<CashHandover>;

/** Entity type under which handovers appear in audit logs, comments, the activity timeline and ledger entries. */
export const CASH_HANDOVER_ENTITY_TYPE = 'cash-handover';

/** One of the user's cash, wallet or cheque accounts on the handover. */
@Schema({ _id: false })
export class HandoverLine {
  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, required: true })
  sourceAccountId: Types.ObjectId;

  /** Snapshot for the slip. */
  @Prop({ required: true })
  sourceAccountName: string;

  @Prop({ type: String, enum: LedgerAccountType, required: true })
  sourceAccountType: LedgerAccountType;

  @Prop({ required: true })
  submittedAmount: number;

  /** Set on approval: never more than submitted; the rest stays in the source account. */
  @Prop({ type: Number, default: null })
  receivedAmount: number | null;

  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, default: null })
  receivedIntoAccountId: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  receivedIntoAccountName: string | null;
}

export const HandoverLineSchema = SchemaFactory.createForClass(HandoverLine);

/**
 * A cheque the user collected on a receipt, handed over as a document: it
 * already sits in the company's cheques in hand (posted by the receipt), so
 * nothing is posted for it; only its chequeStatus moves (with_salesman ->
 * submitted -> at_office). Snapshot for the slip.
 */
@Schema({ _id: false })
export class HandoverCheque {
  /** The cash receipt the cheque was received on. */
  @Prop({ type: Types.ObjectId, required: true })
  receiptId: Types.ObjectId;

  @Prop({ required: true })
  voucherNo: string;

  @Prop({ required: true })
  chequeNumber: string;

  @Prop({ type: String, default: null })
  chequeBankName: string | null;

  @Prop({ type: Date, default: null })
  chequeDate: Date | null;

  @Prop({ required: true })
  amount: number;

  /** The receipt's attachments when handed over (cheque photo). */
  @Prop({ type: [Object], default: [] })
  attachments: { fileRef: Types.ObjectId; title: string; mimeType: string }[];
}

export const HandoverChequeSchema = SchemaFactory.createForClass(HandoverCheque);

/**
 * A bank-transfer receipt the user collected, handed over for the office to
 * verify against its slip. The money already sits in the bank (posted by the
 * receipt), so nothing is posted; bankHandoverStatus moves
 * with_salesman -> submitted -> verified.
 */
@Schema({ _id: false })
export class HandoverBankReceipt {
  @Prop({ type: Types.ObjectId, required: true })
  receiptId: Types.ObjectId;

  @Prop({ required: true })
  voucherNo: string;

  @Prop({ type: String, default: null })
  bankAccountName: string | null;

  @Prop({ type: String, default: null })
  reference: string | null;

  @Prop({ required: true })
  amount: number;

  @Prop({ type: [Object], default: [] })
  attachments: { fileRef: Types.ObjectId; title: string; mimeType: string }[];
}

export const HandoverBankReceiptSchema = SchemaFactory.createForClass(HandoverBankReceipt);

/** A bill photo or PDF, stored through /files. */
@Schema({ _id: false })
export class HandoverFile {
  @Prop({ type: Types.ObjectId, ref: 'FileAttachment', required: true })
  fileRef: Types.ObjectId;

  @Prop({ required: true, trim: true })
  title: string;

  @Prop({ required: true })
  mimeType: string;
}

export const HandoverFileSchema = SchemaFactory.createForClass(HandoverFile);

/**
 * Money the user spent out of what they collected (fuel, parking, ...).
 * Reserved from the source on submit like an amount; approval posts it
 * (debit the expense account, credit the source), so it leaves their pending.
 */
@Schema()
export class HandoverExpense {
  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, required: true })
  expenseAccountId: Types.ObjectId;

  @Prop({ required: true })
  expenseAccountName: string;

  /** One of the user's cash or wallet accounts it was paid from. */
  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, required: true })
  sourceAccountId: Types.ObjectId;

  @Prop({ required: true })
  sourceAccountName: string;

  @Prop({ required: true })
  amount: number;

  @Prop({ type: String, trim: true, default: null })
  description: string | null;

  @Prop({ type: HandoverFileSchema, default: null })
  attachment: HandoverFile | null;
}

export const HandoverExpenseSchema = SchemaFactory.createForClass(HandoverExpense);

/**
 * A user hands money from their own cash, wallet and cheque accounts to the
 * office. Balance-based: what is pending is simply those accounts' balances;
 * nothing is flagged on receipts. Stored as a voucher (see VoucherBase) for
 * its number, scope, comments and PDF:
 * - collectedById / collectedByName: the user handing over (API: userId);
 * - items: per source account, submitted then received amounts;
 * - lines: unused (the posting is per item, on approval).
 *
 * status: submitted -> approved | rejected, or cancelled. Approval debits each
 * receivedInto account and credits its source; cancelling an approved one
 * reverses that. Its own collection: the old receipt-based cash_handovers is
 * left untouched.
 */
@Schema({ collection: 'handovers', toJSON: { virtuals: true }, toObject: { virtuals: true } })
export class CashHandover extends VoucherBase {
  @Prop({ type: [HandoverLineSchema], default: [] })
  items: HandoverLine[];

  /** Cheques handed over as documents; always received in full on approval. */
  @Prop({ type: [HandoverChequeSchema], default: [] })
  cheques: HandoverCheque[];

  /** Bank-transfer receipts handed over for verification; always received in full. */
  @Prop({ type: [HandoverBankReceiptSchema], default: [] })
  bankReceipts: HandoverBankReceipt[];

  /** Spent from the collected cash; posted on approval. */
  @Prop({ type: [HandoverExpenseSchema], default: [] })
  expenses: (HandoverExpense & { _id: Types.ObjectId })[];

  @Prop({ required: true, default: 0 })
  expensesTotal: number;

  @Prop({ required: true, default: 0 })
  submittedTotal: number;

  @Prop({ type: Number, default: null })
  receivedTotal: number | null;

  /** Why less than submitted was received, or why it was rejected. */
  @Prop({ type: String, trim: true, default: null })
  reason: string | null;

  @Prop({ type: UserSnapshotSchema, default: null })
  approvedBy: UserSnapshot | null;

  @Prop({ type: Date, default: null, index: true })
  approvedAt: Date | null;

  @Prop({ type: UserSnapshotSchema, default: null })
  rejectedBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  rejectedAt: Date | null;
}

export const CashHandoverSchema = SchemaFactory.createForClass(CashHandover);
applyVoucherIndexes(CashHandoverSchema);
CashHandoverSchema.index({ 'items.sourceAccountId': 1 });
CashHandoverSchema.index({ 'items.receivedIntoAccountId': 1 });

// API names for the generic voucher fields.
CashHandoverSchema.virtual('userId').get(function (this: CashHandover) {
  return this.collectedById;
});
CashHandoverSchema.virtual('userName').get(function (this: CashHandover) {
  return this.collectedByName;
});
