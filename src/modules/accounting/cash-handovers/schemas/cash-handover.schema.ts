import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { LedgerAccount } from '../../ledger-accounts/schemas/ledger-account.schema.js';
import { PaymentMethod, VoucherBase, applyVoucherIndexes } from '../../vouchers/schemas/voucher.schema.js';
import { UserSnapshot, UserSnapshotSchema } from '../../../../common/schemas/user-snapshot.schema.js';

export type CashHandoverDocument = HydratedDocument<CashHandover>;

/** Entity type under which handovers appear in audit logs, comments, the activity timeline and ledger entries. */
export const CASH_HANDOVER_ENTITY_TYPE = 'cash-handover';

/** A receipt on the handover, as it was when submitted. */
@Schema({ _id: false })
export class HandoverReceipt {
  @Prop({ type: Types.ObjectId, ref: 'CashReceipt', required: true })
  receiptId: Types.ObjectId;

  @Prop({ required: true })
  voucherNo: string;

  @Prop({ required: true })
  voucherDate: Date;

  @Prop({ type: String, enum: PaymentMethod, required: true })
  paymentMethod: PaymentMethod;

  @Prop({ required: true })
  amount: number;
}

export const HandoverReceiptSchema = SchemaFactory.createForClass(HandoverReceipt);

/**
 * Staff who settle with the office (van salesmen) hand over the receipts
 * they collected. Stored as a voucher (see VoucherBase) for its number,
 * scope, comments and PDF:
 * - cashierId / cashierName: the staff member handing over;
 * - fromAccountId: the source (van) cash account, credited on approval;
 * - lines: empty until approved, then one line debiting receivedIntoAccountId
 *   with receivedCash (none if nothing was received); grandTotal = receivedCash.
 *
 * status: submitted -> approved | rejected, or cancelled. Handovers from
 * before approval existed were migrated as approved, with receivedCash = their
 * amount, no receipts, and receivedBy* naming the cashier who took the money.
 */
@Schema({ collection: 'cash_handovers', toJSON: { virtuals: true }, toObject: { virtuals: true } })
export class CashHandover extends VoucherBase {
  /** The source cash or wallet account the receipts' cash sits in; credited on approval. */
  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, required: true, index: true })
  fromAccountId: Types.ObjectId;

  @Prop({ type: [HandoverReceiptSchema], default: [] })
  receipts: HandoverReceipt[];

  /** Cash and wallet receipts: what should arrive. */
  @Prop({ required: true, default: 0 })
  expectedCash: number;

  /** Bank receipts: verified on approval, never posted. */
  @Prop({ required: true, default: 0 })
  bankTotal: number;

  /** What the staff member counted when submitting. */
  @Prop({ type: Number, default: null })
  countedCash: number | null;

  /** Set on approval: never more than expectedCash; less needs varianceReason. */
  @Prop({ type: Number, default: null })
  receivedCash: number | null;

  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, default: null })
  receivedIntoAccountId: Types.ObjectId | null;

  /** Snapshot for the slip. */
  @Prop({ type: String, default: null })
  receivedIntoAccountName: string | null;

  @Prop({ type: String, trim: true, default: null })
  varianceReason: string | null;

  @Prop({ type: UserSnapshotSchema, default: null })
  approvedBy: UserSnapshot | null;

  @Prop({ type: Date, default: null, index: true })
  approvedAt: Date | null;

  @Prop({ type: UserSnapshotSchema, default: null })
  rejectedBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  rejectedAt: Date | null;

  @Prop({ type: String, trim: true, default: null })
  rejectReason: string | null;

  /** Only on handovers from before approval: the cashier who received the money. */
  @Prop({ type: Types.ObjectId, ref: 'Cashier', default: null, index: true })
  receivedByCashierId: Types.ObjectId | null;

  @Prop({ type: String, trim: true, default: null })
  receivedByCashierName: string | null;
}

export const CashHandoverSchema = SchemaFactory.createForClass(CashHandover);
applyVoucherIndexes(CashHandoverSchema);
CashHandoverSchema.index({ 'receipts.receiptId': 1 });

// API names for the generic voucher fields.
CashHandoverSchema.virtual('staffId').get(function (this: CashHandover) {
  return this.cashierId;
});
CashHandoverSchema.virtual('staffName').get(function (this: CashHandover) {
  return this.cashierName;
});
CashHandoverSchema.virtual('sourceAccountId').get(function (this: CashHandover) {
  return this.fromAccountId;
});
CashHandoverSchema.virtual('receiptIds').get(function (this: CashHandover) {
  return (this.receipts ?? []).map((receipt) => receipt.receiptId);
});
