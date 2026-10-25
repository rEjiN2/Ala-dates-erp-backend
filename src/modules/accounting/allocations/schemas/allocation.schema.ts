import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { UserSnapshot, UserSnapshotSchema } from '../../../../common/schemas/user-snapshot.schema.js';
import { round2 } from '../../../../common/utils/money.util.js';

export type AllocationDocument = HydratedDocument<Allocation>;

/** Entity type under which allocations appear in audit logs. */
export const ALLOCATION_ENTITY_TYPE = 'allocation';

/** What a payment line can be applied to. Opening-balance lines of a party act as one "Opening balance" bill. */
export enum AllocationTargetType {
  PURCHASE_INVOICE = 'purchase-invoice',
  SALES_INVOICE = 'sales-invoice',
  OPENING_BALANCE = 'opening-balance',
}

export enum AllocationStatus {
  ACTIVE = 'active',
  REVERSED = 'reversed',
}

export enum PaymentStatus {
  UNPAID = 'unpaid',
  PARTLY_PAID = 'partly_paid',
  PAID = 'paid',
}

export function paymentStatusOf(total: number, paid: number): PaymentStatus {
  if (round2(total - paid) <= 0) return PaymentStatus.PAID;
  return round2(paid) > 0 ? PaymentStatus.PARTLY_PAID : PaymentStatus.UNPAID;
}

/** Overdue is derived, never stored: money still owed after the due day (Asia/Dubai). */
export function isOverdue(dueDate: Date | null | undefined, balance: number): boolean {
  if (!dueDate || !(round2(balance) > 0)) return false;
  const today = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return dueDate.toISOString().slice(0, 10) < today;
}

/**
 * Part of one payment line applied to one bill. Moves no ledger money (the
 * payment already did); it only settles the bill. Never deleted: reversing
 * keeps the row with who/when/why. Whatever a line has not allocated stays
 * on account.
 */
@Schema({ collection: 'allocations', versionKey: false })
export class Allocation {
  /** The payment's entity type, e.g. "cash-payment". */
  @Prop({ required: true })
  paymentVoucherType: string;

  @Prop({ type: Types.ObjectId, required: true })
  paymentVoucherId: Types.ObjectId;

  @Prop({ required: true })
  paymentVoucherNo: string;

  /** 0-based position of the line on the payment (voucher lines carry no id). */
  @Prop({ required: true })
  paymentLineIndex: number;

  @Prop({ type: Types.ObjectId, ref: 'Party', required: true, index: true })
  partyId: Types.ObjectId;

  @Prop({ type: String, enum: AllocationTargetType, required: true })
  targetType: AllocationTargetType;

  @Prop({ type: Types.ObjectId, required: true })
  targetId: Types.ObjectId;

  @Prop({ required: true })
  targetNo: string;

  @Prop({ required: true, min: 0.01 })
  amount: number;

  @Prop({ type: String, enum: AllocationStatus, default: AllocationStatus.ACTIVE, index: true })
  status: AllocationStatus;

  @Prop({ type: UserSnapshotSchema, default: null })
  createdBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  createdAt: Date | null;

  @Prop({ type: UserSnapshotSchema, default: null })
  reversedBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  reversedAt: Date | null;

  @Prop({ type: String, trim: true, default: null })
  reverseReason: string | null;
}

export const AllocationSchema = SchemaFactory.createForClass(Allocation);
AllocationSchema.index({ paymentVoucherType: 1, paymentVoucherId: 1, status: 1 });
AllocationSchema.index({ targetType: 1, targetId: 1, status: 1 });
