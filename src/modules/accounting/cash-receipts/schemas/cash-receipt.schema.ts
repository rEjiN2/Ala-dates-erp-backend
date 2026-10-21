import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { LedgerAccount } from '../../ledger-accounts/schemas/ledger-account.schema.js';
import { UserSnapshot, UserSnapshotSchema } from '../../../../common/schemas/user-snapshot.schema.js';
import {
  PaymentMethod,
  VoucherBase,
  VoucherLine,
  VoucherLineSchema,
  VoucherStatus,
  applyVoucherIndexes,
  paymentMethodFor,
} from '../../vouchers/schemas/voucher.schema.js';

export { PaymentMethod, paymentMethodFor };

export type CashReceiptDocument = HydratedDocument<CashReceipt>;

/** Entity type under which receipts appear in audit logs, comments, the activity timeline and ledger entries. */
export const CASH_RECEIPT_ENTITY_TYPE = 'cash-receipt';

export const CashReceiptStatus = VoucherStatus;
export type CashReceiptStatus = VoucherStatus;

export { VoucherLine as CashReceiptLine, VoucherLineSchema as CashReceiptLineSchema };

/** One step of a cheque's life (deposit, clearance, return): when, where, who. Cleared on undo. */
@Schema({ _id: false })
export class ChequeStep {
  @Prop({ required: true })
  date: Date;

  /** Deposit: the bank it went to. Clearance: the account it was posted into. */
  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, default: null })
  accountId: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  accountName: string | null;

  /** Return: why it bounced. */
  @Prop({ type: String, trim: true, default: null })
  reason: string | null;

  @Prop({ type: UserSnapshotSchema, required: true })
  by: UserSnapshot;

  @Prop({ required: true })
  at: Date;
}

export const ChequeStepSchema = SchemaFactory.createForClass(ChequeStep);

/** A file attached to the receipt (cheque photo, transfer slip), stored through /files. */
@Schema()
export class ReceiptAttachment {
  @Prop({ type: Types.ObjectId, ref: 'FileAttachment', required: true })
  fileRef: Types.ObjectId;

  @Prop({ required: true, trim: true })
  title: string;

  @Prop({ required: true })
  mimeType: string;

  @Prop({ required: true })
  uploadedAt: Date;
}

export const ReceiptAttachmentSchema = SchemaFactory.createForClass(ReceiptAttachment);

/** Shared voucher fields (see VoucherBase) plus the account the money is received into. */
@Schema({ collection: 'cash_receipts' })
export class CashReceipt extends VoucherBase {
  /** "Received into": an active cash, wallet or bank account (named from when only cash was allowed). */
  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, required: true, index: true })
  cashAccountId: Types.ObjectId;

  @Prop({ type: ChequeStepSchema, default: null })
  chequeDeposit: ChequeStep | null;

  @Prop({ type: ChequeStepSchema, default: null })
  chequeClearance: ChequeStep | null;

  @Prop({ type: ChequeStepSchema, default: null })
  chequeReturn: ChequeStep | null;

  @Prop({ type: [ReceiptAttachmentSchema], default: [] })
  attachments: (ReceiptAttachment & { _id: Types.ObjectId })[];
}

export const CashReceiptSchema = SchemaFactory.createForClass(CashReceipt);
applyVoucherIndexes(CashReceiptSchema);
