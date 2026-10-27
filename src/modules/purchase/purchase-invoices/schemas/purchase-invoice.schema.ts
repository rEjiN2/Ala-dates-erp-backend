import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { VoucherStatus } from '../../../accounting/vouchers/schemas/voucher.schema.js';
import { UserSnapshot, UserSnapshotSchema } from '../../../../common/schemas/user-snapshot.schema.js';
import { PaymentStatus } from '../../../accounting/allocations/schemas/allocation.schema.js';

export type PurchaseInvoiceDocument = HydratedDocument<PurchaseInvoice>;

/** Entity type under which purchase invoices appear in audit logs, comments, the activity timeline, ledger and stock entries. */
export const PURCHASE_INVOICE_ENTITY_TYPE = 'purchase-invoice';

/** One product bought. All amounts are computed server-side. The line's _id is what a purchase return names. */
@Schema()
export class PurchaseInvoiceLine {
  _id?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ required: true })
  qty: number;

  /** Before VAT, up to 4 decimals. */
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

  /** Quantity on active purchase returns; moved only by the returns service. */
  @Prop({ default: 0 })
  returnedQty?: number;
}

export const PurchaseInvoiceLineSchema = SchemaFactory.createForClass(PurchaseInvoiceLine);

/**
 * A supplier's bill (PI-0001): Dr Purchases (net before VAT), Dr VAT Input,
 * Cr supplier (net total), and a stock-in entry per stock/bundle line at the
 * location. Edit = reverse + repost; cancel reverses; no delete. Both are
 * refused when the stock has already been used.
 */
@Schema({ collection: 'purchase_invoices', versionKey: false })
export class PurchaseInvoice {
  @Prop({ required: true, unique: true, trim: true })
  voucherNo: string;

  @Prop({ required: true, index: true })
  voucherDate: Date;

  @Prop({ type: Types.ObjectId, ref: 'Party', required: true, index: true })
  supplierId: Types.ObjectId;

  /** The supplier's ledger account at the time of posting. */
  @Prop({ type: Types.ObjectId, ref: 'LedgerAccount', required: true, index: true })
  supplierAccountId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Location', required: true, index: true })
  locationId: Types.ObjectId;

  /** The supplier's own invoice number; unique per supplier among non-cancelled invoices. */
  @Prop({ required: true, trim: true })
  billNo: string;

  @Prop({ type: Date, default: null })
  billDate: Date | null;

  @Prop({ required: true })
  dueDate: Date;

  @Prop({ type: String, trim: true, default: null })
  remarks: string | null;

  /** FileAttachment ids from the /files module. */
  @Prop({ type: [Types.ObjectId], ref: 'FileAttachment', default: [] })
  attachmentFileRefs: Types.ObjectId[];

  @Prop({ required: true, default: true })
  updatePurchasePrice: boolean;

  @Prop({ type: [PurchaseInvoiceLineSchema], required: true, default: [] })
  lines: PurchaseInvoiceLine[];

  /** Sum of qty x rate. */
  @Prop({ required: true, default: 0 })
  grossTotal: number;

  @Prop({ required: true, default: 0 })
  totalDiscount: number;

  /** Net before VAT: debited to Purchases. */
  @Prop({ required: true, default: 0 })
  taxableTotal: number;

  @Prop({ required: true, default: 0 })
  totalTax: number;

  /** Credited to the supplier. */
  @Prop({ required: true, default: 0 })
  netTotal: number;

  /** Active payment allocations; balance = netTotal - paidAmount - creditedAmount. Moved only by AllocationService. */
  @Prop({ required: true, default: 0 })
  paidAmount: number;

  /** Active credit-note (purchase return) allocations. */
  @Prop({ default: 0 })
  creditedAmount?: number;

  @Prop({ required: true, default: 0 })
  balance: number;

  /** On active purchase returns: total quantity and net amount (incl. VAT). Moved only by the returns service. */
  @Prop({ default: 0 })
  returnedQty?: number;

  @Prop({ default: 0 })
  returnedAmount?: number;

  /** Overdue is derived from dueDate and balance, never stored. */
  @Prop({ type: String, enum: PaymentStatus, default: PaymentStatus.UNPAID, index: true })
  paymentStatus: PaymentStatus;

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

export const PurchaseInvoiceSchema = SchemaFactory.createForClass(PurchaseInvoice);
PurchaseInvoiceSchema.index({ 'lines.productId': 1 });
// Backstop for the service's duplicate check: one posted bill number per supplier, ignoring case.
PurchaseInvoiceSchema.index(
  { supplierId: 1, billNo: 1 },
  {
    unique: true,
    partialFilterExpression: { status: VoucherStatus.POSTED },
    collation: { locale: 'en', strength: 2 },
    name: 'supplier_billNo_posted_unique',
  },
);
