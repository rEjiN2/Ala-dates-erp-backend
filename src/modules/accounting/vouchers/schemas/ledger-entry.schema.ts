import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { LedgerAccount } from '../../ledger-accounts/schemas/ledger-account.schema.js';
import { insertOnlyPlugin } from '../../../../common/utils/insert-only.plugin.js';

export type LedgerEntryDocument = HydratedDocument<LedgerEntry>;

export enum LedgerEntryKind {
  /** The voucher's effect on the account. */
  POSTING = 'posting',
  /** Undoes an earlier posting (edit, cancel or delete). */
  REVERSAL = 'reversal',
}

/**
 * One debit or credit on one account, written by VoucherPostingService in the
 * same transaction as the balance change it explains. Append-only: an edit or
 * cancel writes reversing rows instead of changing old ones, so for every
 * account, balance == sum(debit - credit) over its entries.
 */
@Schema({ collection: 'ledger_entries', versionKey: false })
export class LedgerEntry {
  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, required: true })
  accountId: Types.ObjectId;

  /** The voucher's entity type, e.g. "cash-receipt", "cash-payment". */
  @Prop({ required: true })
  voucherType: string;

  @Prop({ type: Types.ObjectId, required: true })
  voucherId: Types.ObjectId;

  @Prop({ required: true })
  voucherNo: string;

  /** The voucher's date at the time of this row (a reposted edit may carry a new date). */
  @Prop({ required: true })
  voucherDate: Date;

  @Prop({ required: true, min: 0, default: 0 })
  debit: number;

  @Prop({ required: true, min: 0, default: 0 })
  credit: number;

  @Prop({ type: String, default: null })
  narration: string | null;

  @Prop({ type: String, enum: LedgerEntryKind, required: true })
  kind: LedgerEntryKind;

  /** What caused the row: created, updated, cancelled or deleted. */
  @Prop({ required: true })
  cause: string;

  @Prop({ required: true })
  postedAt: Date;
}

export const LedgerEntrySchema = SchemaFactory.createForClass(LedgerEntry);

// Account statements, and the per-account reconciliation.
LedgerEntrySchema.index({ accountId: 1, voucherDate: 1 });
// Everything one voucher posted.
LedgerEntrySchema.index({ voucherType: 1, voucherId: 1 });
LedgerEntrySchema.plugin(insertOnlyPlugin, { modelName: LedgerEntry.name });
