import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import type { Schema as MongooseSchema } from 'mongoose';
import { LedgerAccount, LedgerAccountType } from '../../ledger-accounts/schemas/ledger-account.schema.js';
import { UserSnapshot, UserSnapshotSchema } from '../../../../common/schemas/user-snapshot.schema.js';

/** Receipts and payments are posted or cancelled; handovers go submitted, then approved or rejected (or cancelled). */
export enum VoucherStatus {
  POSTED = 'posted',
  CANCELLED = 'cancelled',
  SUBMITTED = 'submitted',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

/**
 * How the money moved, derived from the header account's type: bank
 * accounts give "bank", cheque accounts "cheque", cash and wallet "cash".
 */
export enum PaymentMethod {
  CASH = 'cash',
  CHEQUE = 'cheque',
  BANK = 'bank',
}

/** Where a cheque received on a receipt stands. Server-set only. */
export enum ChequeStatus {
  /** Still with the salesman who collected it (set by handover). */
  WITH_SALESMAN = 'with_salesman',
  /** On a submitted handover. */
  SUBMITTED = 'submitted',
  AT_OFFICE = 'at_office',
  /** Taken to the bank; nothing posted yet. */
  DEPOSITED = 'deposited',
  /** Money arrived: posted from cheques in hand to the destination account. */
  CLEARED = 'cleared',
  /** Bounced: the receipt's posting was reversed, so the customer owes again. */
  RETURNED = 'returned',
}

/**
 * A bank receipt by a user who settles with the office: the money is already
 * in the bank, but the office verifies it (with its slip) on a handover.
 * Server-set only; null for everyone else.
 */
export enum BankHandoverStatus {
  WITH_SALESMAN = 'with_salesman',
  /** On a submitted handover: locked until it is approved, rejected or cancelled. */
  SUBMITTED = 'submitted',
  /** Approved on a handover. */
  VERIFIED = 'verified',
}

/** A cheque receipt can be edited or cancelled only in these states; later ones must be undone first. */
export const EDITABLE_CHEQUE_STATUSES: readonly ChequeStatus[] = [ChequeStatus.AT_OFFICE, ChequeStatus.WITH_SALESMAN];

export function paymentMethodFor(accountType: LedgerAccountType): PaymentMethod {
  if (accountType === LedgerAccountType.BANK) return PaymentMethod.BANK;
  if (accountType === LedgerAccountType.CHEQUE) return PaymentMethod.CHEQUE;
  return PaymentMethod.CASH;
}

@Schema({ _id: false })
export class VoucherLine {
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

export const VoucherLineSchema = SchemaFactory.createForClass(VoucherLine);

/**
 * Fields every cash/bank voucher shares. Each voucher type extends this with
 * its own header account field (cashAccountId, paidFromAccountId, ...) and
 * its own collection; VoucherPostingService works on any of them.
 *
 * Who/when fields are set only by the service, from the authenticated user.
 * They are not Mongoose timestamps: updatedAt moves only on a real edit,
 * never on a rejected no-op or a cancel.
 */
export abstract class VoucherBase {
  @Prop({ required: true, unique: true, trim: true })
  voucherNo: string;

  @Prop({ required: true, index: true })
  voucherDate: Date;

  /**
   * The user who handled the money: "Collected By" on receipts, "Paid By" on
   * payments. null only on vouchers whose old
   * cashier had no linked login; those keep the old name in collectedByName
   * and must be given a user before they can be edited.
   */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null, index: true })
  collectedById: Types.ObjectId | null;

  /** That user's name when it was set on this voucher. Historical snapshot, not refreshed on rename. */
  @Prop({ type: String, trim: true, default: null })
  collectedByName: string | null;

  /** Set by the server from the header account's type. Vouchers from before bank support read as "cash". */
  @Prop({ type: String, enum: PaymentMethod, default: PaymentMethod.CASH })
  paymentMethod: PaymentMethod;

  /** Cheque number, transfer reference, etc. Required on cheque vouchers. */
  @Prop({ type: String, trim: true, default: null })
  paymentReference: string | null;

  /** Cheque vouchers only (one cheque per voucher); null otherwise. Post-dated allowed. */
  @Prop({ type: Date, default: null })
  chequeDate: Date | null;

  @Prop({ type: String, trim: true, default: null })
  chequeNumber: string | null;

  /** The bank the cheque is drawn on. A number + bank pair is unique among non-cancelled vouchers. */
  @Prop({ type: String, trim: true, default: null })
  chequeBankName: string | null;

  @Prop({ type: String, enum: [...Object.values(ChequeStatus), null], default: null, index: true })
  chequeStatus: ChequeStatus | null;

  @Prop({ type: String, enum: [...Object.values(BankHandoverStatus), null], default: null })
  bankHandoverStatus: BankHandoverStatus | null;

  @Prop({ trim: true })
  comments?: string;

  @Prop({ type: [VoucherLineSchema], required: true, default: [] })
  lines: VoucherLine[];

  @Prop({ required: true, default: 0 })
  grossTotal: number;

  @Prop({ required: true, default: 0 })
  totalTax: number;

  @Prop({ required: true, default: 0 })
  grandTotal: number;

  /** Absent on receipts created before cancellation existed; those read as posted. */
  @Prop({ type: String, enum: VoucherStatus, default: VoucherStatus.POSTED, index: true })
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

  /** How many times the voucher PDF has been generated; 1 is the ORIGINAL, later ones are DUPLICATEs. */
  @Prop({ type: Number, default: 0, min: 0 })
  printCount: number;
}

export type VoucherDocument = HydratedDocument<VoucherBase>;

/** Indexes every voucher collection needs, beyond the per-field ones above. */
export function applyVoucherIndexes(schema: MongooseSchema): void {
  // Backs the "is this ledger account used?" check and the list's accountId filter.
  schema.index({ 'lines.accountId': 1 });
  // List "Created by" filter.
  schema.index({ 'createdBy.id': 1 });
}
