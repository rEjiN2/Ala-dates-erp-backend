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
