import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { LedgerAccount } from '../../ledger-accounts/schemas/ledger-account.schema.js';
import { VoucherStatus } from '../../vouchers/schemas/voucher.schema.js';
import { UserSnapshot, UserSnapshotSchema } from '../../../../common/schemas/user-snapshot.schema.js';

export type OpeningBalanceDocument = HydratedDocument<OpeningBalance>;

/** Entity type under which opening balances appear in audit logs, comments, the activity timeline and ledger entries. */
export const OPENING_BALANCE_ENTITY_TYPE = 'opening-balance';

/** systemKey of the account that absorbs each opening voucher's debit/credit difference. */
export const OPENING_BALANCE_EQUITY_KEY = 'opening-balance-equity';
export const OPENING_BALANCE_EQUITY_NAME = 'Opening Balance Equity';

/** One account's opening balance: a debit or a credit, never both. */
@Schema({ _id: false })
export class OpeningBalanceLine {
  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, required: true })
  accountId: Types.ObjectId;

  @Prop({ required: true, default: 0 })
  debit: number;

  @Prop({ required: true, default: 0 })
  credit: number;
}

export const OpeningBalanceLineSchema = SchemaFactory.createForClass(OpeningBalanceLine);

/**
 * Opening balances as of a date (OB-0001). Posts a ledger entry per line plus
 * one entry on Opening Balance Equity for the difference (equityDebit or
 * equityCredit), all in one transaction. An account is on at most one
 * non-cancelled opening voucher. Edit = reverse + repost; cancel reverses.
 */
@Schema({ collection: 'opening_balances', versionKey: false })
export class OpeningBalance {
  @Prop({ required: true, unique: true, trim: true })
  voucherNo: string;

  @Prop({ required: true, index: true })
  asOfDate: Date;

  @Prop({ trim: true })
  comments?: string;

  @Prop({ type: [OpeningBalanceLineSchema], required: true, default: [] })
  lines: OpeningBalanceLine[];

  @Prop({ required: true, default: 0 })
  totalDebit: number;

  @Prop({ required: true, default: 0 })
  totalCredit: number;

  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, required: true })
  equityAccountId: Types.ObjectId;

  /** The balancing entry: debits short of credits are debited to equity, the excess credited. */
  @Prop({ required: true, default: 0 })
  equityDebit: number;

  @Prop({ required: true, default: 0 })
  equityCredit: number;

  @Prop({ type: String, enum: [VoucherStatus.POSTED, VoucherStatus.CANCELLED], default: VoucherStatus.POSTED, index: true })
  status: VoucherStatus;

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

export const OpeningBalanceSchema = SchemaFactory.createForClass(OpeningBalance);
OpeningBalanceSchema.index({ 'lines.accountId': 1 });
OpeningBalanceSchema.index({ 'createdBy.id': 1 });
