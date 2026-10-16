import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { LedgerAccount, LedgerAccountType } from '../../ledger-accounts/schemas/ledger-account.schema.js';
import { UserSnapshot, UserSnapshotSchema } from '../../../../common/schemas/user-snapshot.schema.js';

export type CashReceiptDocument = HydratedDocument<CashReceipt>;

/** Entity type under which receipts appear in audit logs, comments and the activity timeline. */
export const CASH_RECEIPT_ENTITY_TYPE = 'cash-receipt';

/**
 * How the money came in, derived from the "received into" account's type:
 * bank accounts give "bank", cash and wallet accounts give "cash".
 */
export enum PaymentMethod {
  CASH = 'cash',
  BANK = 'bank',
}

export function paymentMethodFor(accountType: LedgerAccountType): PaymentMethod {
  return accountType === LedgerAccountType.BANK ? PaymentMethod.BANK : PaymentMethod.CASH;
}

export enum CashReceiptStatus {
  POSTED = 'posted',
  CANCELLED = 'cancelled',
}

@Schema({ _id: false })
export class CashReceiptLine {
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

export const CashReceiptLineSchema = SchemaFactory.createForClass(CashReceiptLine);

/**
 * Who/when fields are set only by the service, from the authenticated user.
 * They are not Mongoose timestamps: updatedAt must move only on a real edit,
 * never on a rejected no-op or a cancel. Receipts created before audit
 * tracking have null createdBy/updatedBy; that is shown as unknown, not
 * back-filled.
 */
@Schema({ collection: 'cash_receipts' })
export class CashReceipt {
  @Prop({ required: true, unique: true, trim: true })
  voucherNo: string;

  @Prop({ required: true, index: true })
  voucherDate: Date;

  @Prop({
    type: Types.ObjectId,
    ref: LedgerAccount.name,
    required: true,
    index: true,
  })
  cashAccountId: Types.ObjectId;

  /**
   * The cashier master record. null only on receipts entered before the
   * cashier master existed; those keep their free-text cashier in cashierName,
   * and must be given a cashier before they can be edited.
   */
  @Prop({ type: Types.ObjectId, ref: 'Cashier', default: null, index: true })
  cashierId: Types.ObjectId | null;

  /** Cashier's name when it was set on this receipt. Historical snapshot, not refreshed on rename. */
  @Prop({ type: String, trim: true, default: null })
  cashierName: string | null;

  /** Set by the server from the account type. Receipts from before bank receipts existed read as "cash". */
  @Prop({ type: String, enum: PaymentMethod, default: PaymentMethod.CASH })
  paymentMethod: PaymentMethod;

  /** Cheque number, transfer reference, etc. */
  @Prop({ type: String, trim: true, default: null })
  paymentReference: string | null;

  @Prop({ trim: true })
  comments?: string;

  @Prop({ type: [CashReceiptLineSchema], required: true, default: [] })
  lines: CashReceiptLine[];

  @Prop({ required: true, default: 0 })
  grossTotal: number;

  @Prop({ required: true, default: 0 })
  totalTax: number;

  @Prop({ required: true, default: 0 })
  grandTotal: number;

  /** Absent on receipts created before cancellation existed; those read as posted. */
  @Prop({
    type: String,
    enum: CashReceiptStatus,
    default: CashReceiptStatus.POSTED,
    index: true,
  })
  status: CashReceiptStatus;

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

export const CashReceiptSchema = SchemaFactory.createForClass(CashReceipt);

// Backs the "is this ledger account used?" check that guards account deletion,
// and the list's accountId filter.
CashReceiptSchema.index({ 'lines.accountId': 1 });
// List "Created by" filter.
CashReceiptSchema.index({ 'createdBy.id': 1 });
