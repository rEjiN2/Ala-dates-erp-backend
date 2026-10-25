import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { VoucherStatus } from '../../../accounting/vouchers/schemas/voucher.schema.js';
import { UserSnapshot, UserSnapshotSchema } from '../../../../common/schemas/user-snapshot.schema.js';
import { PaymentStatus } from '../../../accounting/allocations/schemas/allocation.schema.js';

export type SalesInvoiceDocument = HydratedDocument<SalesInvoice>;

/** Entity type under which sales invoices appear in audit logs, comments, the activity timeline, ledger and stock entries. */
export const SALES_INVOICE_ENTITY_TYPE = 'sales-invoice';

/** One product sold. All amounts are computed server-side. */
@Schema({ _id: false })
export class SalesInvoiceLine {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ required: true })
  qty: number;

  /** Before VAT; the product's sale price unless overridden (sales:override-price). */
  @Prop({ required: true })
  rate: number;

  @Prop({ required: true, default: 0 })
  discount: number;

  /** qty x rate - discount. */
  @Prop({ required: true })
  amount: number;

  /** Percent. */
  @Prop({ required: true })
  vatRate: number;

  @Prop({ required: true })
  vat: number;

  /** amount + vat. */
  @Prop({ required: true })
  netAmount: number;

  /** The product's purchase price when sold; returned only with products:view-cost. */
  @Prop({ required: true, default: 0 })
  unitCost: number;
}

export const SalesInvoiceLineSchema = SchemaFactory.createForClass(SalesInvoiceLine);

/**
 * A sale (SI-0001): Dr customer (net total), Cr Sales (net before VAT), Cr
 * VAT Output, and a stock-out entry per stock/bundle line at the location.
 * Pay-at-sale creates a cash receipt allocated to the invoice in the same
 * transaction. Edit = reverse + repost (only while unpaid); cancel reverses.
 */
@Schema({ collection: 'sales_invoices', versionKey: false })
export class SalesInvoice {
  @Prop({ required: true, unique: true, trim: true })
  voucherNo: string;

  @Prop({ required: true, index: true })
  voucherDate: Date;

  @Prop({ type: Types.ObjectId, ref: 'Party', required: true, index: true })
  customerId: Types.ObjectId;

  /** The customer's ledger account at the time of posting. */
  @Prop({ type: Types.ObjectId, ref: 'LedgerAccount', required: true, index: true })
  customerAccountId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Location', required: true, index: true })
  locationId: Types.ObjectId;

  /** The salesman; defaults to the creator. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  soldById: Types.ObjectId;

  @Prop({ required: true, trim: true })
  soldByName: string;

  @Prop({ required: true })
  dueDate: Date;

  @Prop({ type: String, trim: true, default: null })
  remarks: string | null;

  @Prop({ type: [SalesInvoiceLineSchema], required: true, default: [] })
  lines: SalesInvoiceLine[];

  /** Sum of qty x rate. */
  @Prop({ required: true, default: 0 })
  grossTotal: number;

  @Prop({ required: true, default: 0 })
  totalDiscount: number;

  /** Net before VAT: credited to Sales. */
  @Prop({ required: true, default: 0 })
  taxableTotal: number;

  @Prop({ required: true, default: 0 })
  totalTax: number;

  /** Debited to the customer. */
  @Prop({ required: true, default: 0 })
  netTotal: number;

  /** Sum of active allocations; balance = netTotal - paidAmount. Moved only by AllocationService. */
  @Prop({ required: true, default: 0 })
  paidAmount: number;

  @Prop({ required: true, default: 0 })
  balance: number;

  @Prop({ type: String, enum: PaymentStatus, default: PaymentStatus.UNPAID, index: true })
  paymentStatus: PaymentStatus;

  /** The cash receipt created by pay-at-sale, if any. */
  @Prop({ type: Types.ObjectId, ref: 'CashReceipt', default: null })
  paymentReceiptId: Types.ObjectId | null;

  @Prop({ type: String, enum: [VoucherStatus.POSTED, VoucherStatus.CANCELLED], default: VoucherStatus.POSTED, index: true })
  status: VoucherStatus;

  @Prop({ default: 0 })
  printCount: number;

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

export const SalesInvoiceSchema = SchemaFactory.createForClass(SalesInvoice);
SalesInvoiceSchema.index({ 'lines.productId': 1 });
SalesInvoiceSchema.index({ 'createdBy.id': 1 });
