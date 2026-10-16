import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import type { Schema as MongooseSchema } from 'mongoose';
import { LedgerAccount, LedgerAccountType } from '../../ledger-accounts/schemas/ledger-account.schema.js';
import { UserSnapshot, UserSnapshotSchema } from '../../../../common/schemas/user-snapshot.schema.js';

export enum VoucherStatus {
  POSTED = 'posted',
  CANCELLED = 'cancelled',
}

/**
 * How the money moved, derived from the header account's type: bank
 * accounts give "bank", cash and wallet accounts give "cash".
 */
export enum PaymentMethod {
  CASH = 'cash',
  BANK = 'bank',
}

export function paymentMethodFor(accountType: LedgerAccountType): PaymentMethod {
  return accountType === LedgerAccountType.BANK ? PaymentMethod.BANK : PaymentMethod.CASH;
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
   * The cashier master record. null only on receipts entered before the
   * cashier master existed; those keep their free-text cashier in cashierName,
   * and must be given a cashier before they can be edited.
   */
  @Prop({ type: Types.ObjectId, ref: 'Cashier', default: null, index: true })
  cashierId: Types.ObjectId | null;

  /** Cashier's name when it was set on this voucher. Historical snapshot, not refreshed on rename. */
  @Prop({ type: String, trim: true, default: null })
  cashierName: string | null;

  /** Set by the server from the header account's type. Vouchers from before bank support read as "cash". */
  @Prop({ type: String, enum: PaymentMethod, default: PaymentMethod.CASH })
  paymentMethod: PaymentMethod;

  /** Cheque number, transfer reference, etc. */
  @Prop({ type: String, trim: true, default: null })
  paymentReference: string | null;

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
