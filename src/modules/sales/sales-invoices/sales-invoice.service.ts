import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import {
  SALES_INVOICE_ENTITY_TYPE,
  SalesInvoice,
  SalesInvoiceDocument,
  type SalesInvoiceLine,
} from './schemas/sales-invoice.schema.js';
import {
  CancelSalesInvoiceDto,
  CreateSalesInvoiceDto,
  type InvoiceKind,
  PreviewSalesInvoiceDto,
  SalesInvoiceLineDto,
  SalesInvoiceQueryDto,
  UpdateSalesInvoiceDto,
} from './dto/sales-invoice.dto.js';
import { priceInvoice, type DiscountType } from './sales-pricing.js';
import { CostService } from '../../stock/costing/cost.service.js';
import { STOCK_PRODUCT_TYPES, StockService, roundQty, stockLocationScope, type StockEntryInput } from '../../stock/stock.service.js';
import { Product, ProductDocument, ProductStatus } from '../../product/products/schemas/product.schema.js';
import { ProductUsageRegistry } from '../../product/products/product-usage.registry.js';
import { CASH_CUSTOMER_KEY, Party, PartyDocument, PartyKind, PartyStatus } from '../../party/schemas/party.schema.js';
import { Location, LocationDocument } from '../../location/schemas/location.schema.js';
import { VoucherStatus } from '../../accounting/vouchers/schemas/voucher.schema.js';
import { LedgerEntryKind } from '../../accounting/vouchers/schemas/ledger-entry.schema.js';
import { VoucherPostingService } from '../../accounting/vouchers/voucher-posting.service.js';
import { buildPlainInvoicePdf, buildVoucherPdf, copyLabel, formatVoucherDate, itemDocument } from '../../accounting/vouchers/voucher-pdf.js';
import { printLayout } from '../../../common/pdf/print-layout.js';
import type { PrintedVoucher } from '../../accounting/vouchers/voucher-print.service.js';
import { isOwnScope, resolveCollectorId, withScope } from '../../accounting/vouchers/data-scope.js';
import { LedgerAccountService } from '../../accounting/ledger-accounts/ledger-account.service.js';
import { LedgerAccountUsageRegistry } from '../../accounting/ledger-accounts/ledger-account-usage.registry.js';
import { SYSTEM_ACCOUNTS } from '../../accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { CashReceiptService } from '../../accounting/cash-receipts/cash-receipt.service.js';
import { CashReceipt, CashReceiptDocument } from '../../accounting/cash-receipts/schemas/cash-receipt.schema.js';
import { AllocationService } from '../../accounting/allocations/allocation.service.js';
import {
  AllocationTargetType,
  isOverdue,
  paymentStatusOf,
} from '../../accounting/allocations/schemas/allocation.schema.js';
import { CompanyService } from '../../company/company.service.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { escapeRegExp } from '../../sequence/code-sequence.js';
import { UsersService } from '../../users/users.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction, type AuditChange } from '../../audit/schemas/audit-log.schema.js';
import { diffFields } from '../../audit/field-diff.js';
import { CommentsService } from '../../comments/comments.service.js';
import { EntityAccessRegistry } from '../../comments/entity-access.registry.js';
import { Permission, hasPermission } from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { type UserSnapshot, toUserSnapshot, userRefOf } from '../../../common/schemas/user-snapshot.schema.js';
import { round2, sum2 } from '../../../common/utils/money.util.js';
import { renderPdf } from '../../../common/pdf/pdf-renderer.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';

type Viewer = AuthenticatedUser;

const SEQUENCE = { key: 'sales-invoice', prefix: 'SI-', width: 4 };
const NON_VAT_SEQUENCE = { key: 'SNV', prefix: 'SNV-', width: 4 };
const LABEL = 'Sales invoice';
const DAY_MS = 24 * 60 * 60 * 1000;
const TOLERANCE = 0.001;

interface PrepareInput {
  date: string;
  customerId: string;
  locationId: string;
  dueDate?: string;
  remarks?: string | null;
  lines: SalesInvoiceLineDto[];
  discountType?: DiscountType;
  discountValue?: number;
  invoiceKind?: InvoiceKind;
}

/** Everything a save writes onto the invoice, checked and priced. */
interface Prepared {
  invoiceKind: InvoiceKind;
  voucherDate: Date;
  customerId: Types.ObjectId;
  customerAccountId: Types.ObjectId;
  locationId: Types.ObjectId;
  dueDate: Date;
  remarks: string | null;
  lines: SalesInvoiceLine[];
  grossTotal: number;
  totalDiscount: number;
  discountType: DiscountType;
  discountValue: number;
  invoiceDiscount: number;
  taxableTotal: number;
  totalTax: number;
  netTotal: number;
}

/**
 * Sales invoices. One transaction per save: number, ledger entries (Dr
 * customer, Cr Sales, Cr VAT Output), stock-out per stock/bundle line, the
 * pay-at-sale receipt and its allocation, and audit. Edit = reverse + repost,
 * only while no payment is applied. "own"-scoped users see invoices they
 * created or sold, and sell only from their allowedLocationIds.
 */
@Injectable()
export class SalesInvoiceService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(SalesInvoice.name) private readonly model: Model<SalesInvoiceDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(Party.name) private readonly partyModel: Model<PartyDocument>,
    @InjectModel(Location.name) private readonly locationModel: Model<LocationDocument>,
    @InjectModel(CashReceipt.name) private readonly receiptModel: Model<CashReceiptDocument>,
    private readonly stockService: StockService,
    private readonly costService: CostService,
    private readonly posting: VoucherPostingService,
    private readonly ledgerAccountService: LedgerAccountService,
    private readonly sequenceService: SequenceService,
    private readonly auditService: AuditService,
    private readonly commentsService: CommentsService,
    private readonly companyService: CompanyService,
    private readonly allocations: AllocationService,
    private readonly cashReceipts: CashReceiptService,
    private readonly usersService: UsersService,
    entityAccess: EntityAccessRegistry,
    productUsage: ProductUsageRegistry,
    ledgerUsage: LedgerAccountUsageRegistry,
  ) {
    entityAccess.register(SALES_INVOICE_ENTITY_TYPE, {
      exists: async (id, user) => Boolean(await this.model.exists(withScope({ _id: id }, scopeOf(user))).exec()),
      canRead: (user) => hasPermission(user, Permission.SALES_INVOICES_READ),
    });
    productUsage.register('sales invoices', async (productId, session) =>
      Boolean(
        await this.model
          .exists({ 'lines.productId': productId })
          .session(session ?? null)
          .exec(),
      ),
    );
    // Blocks deleting the customer (Parties checks its ledger account's usage).
    ledgerUsage.register('sales invoices', async (accountId, session) =>
      Boolean(
        await this.model
          .exists({ customerAccountId: accountId })
          .session(session ?? null)
          .exec(),
      ),
    );
  }

  async findAll(query: SalesInvoiceQueryDto = {}, viewer?: Viewer) {
    const filter: Record<string, unknown> = {};
    if (query.dateFrom || query.dateTo) {
      const range: { $gte?: Date; $lte?: Date } = {};
      if (query.dateFrom) range.$gte = new Date(query.dateFrom);
      if (query.dateTo) range.$lte = endOfDayIfDateOnly(query.dateTo);
      filter.voucherDate = range;
    }
    if (query.status === 'posted') filter.status = VoucherStatus.POSTED;
    else if (query.status === 'cancelled') filter.status = VoucherStatus.CANCELLED;
    if (query.paymentStatus) {
      filter.paymentStatus = query.paymentStatus;
      filter.status ??= VoucherStatus.POSTED;
    }
    if (query.customerId) filter.customerId = new Types.ObjectId(query.customerId);
    if (query.locationId) filter.locationId = new Types.ObjectId(query.locationId);
    if (query.soldById) filter.soldById = new Types.ObjectId(query.soldById);
    const kind = query.kind ?? 'tax';
    if (kind === 'non_vat') {
      assertKindPermission(viewer, 'non_vat', Permission.NON_VAT_INVOICES_READ, 'view');
      filter.invoiceKind = 'non_vat';
    } else if (kind === 'tax') {
      filter.invoiceKind = { $ne: 'non_vat' };
    }
    const term = query.q?.trim();
    if (term) filter.voucherNo = new RegExp(escapeRegExp(term), 'i');
    const scoped = withScope(filter, scopeOf(viewer));
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const [docs, summaryRows] = await Promise.all([
      this.model
        .find(scoped)
        .sort({ voucherDate: -1, voucherNo: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean()
        .exec(),
      this.model
        .aggregate<{ count: number; netTotal: number; outstanding: number }>([
          { $match: scoped },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              // Cancelled invoices are owed nothing.
              netTotal: { $sum: { $cond: [{ $eq: ['$status', VoucherStatus.CANCELLED] }, 0, '$netTotal'] } },
              outstanding: { $sum: { $cond: [{ $eq: ['$status', VoucherStatus.CANCELLED] }, 0, '$balance'] } },
            },
          },
        ])
        .exec(),
    ]);
    const [comments, locations, customers] = await Promise.all([
      this.commentsService.countByEntityIds(
        SALES_INVOICE_ENTITY_TYPE,
        docs.map((doc) => doc._id),
      ),
      this.namesOf(this.locationModel, docs.map((doc) => doc.locationId)),
      this.namesOf(this.partyModel, docs.map((doc) => doc.customerId)),
    ]);
    return {
      items: docs.map((doc) => ({
        id: doc._id.toString(),
        voucherNo: doc.voucherNo,
        voucherDate: doc.voucherDate,
        invoiceKind: doc.invoiceKind ?? 'tax',
        customer: { id: doc.customerId.toString(), name: customers.get(doc.customerId.toString()) ?? null },
        location: { id: doc.locationId.toString(), name: locations.get(doc.locationId.toString()) ?? null },
        soldBy: { id: doc.soldById.toString(), name: doc.soldByName },
        dueDate: doc.dueDate,
        lineCount: doc.lines.length,
        taxableTotal: doc.taxableTotal,
        totalTax: doc.totalTax,
        netTotal: doc.netTotal,
        paidAmount: doc.paidAmount,
        creditedAmount: doc.creditedAmount ?? 0,
        returnedQty: doc.returnedQty ?? 0,
        returnedAmount: doc.returnedAmount ?? 0,
        balance: doc.balance,
        paymentStatus: doc.paymentStatus,
        overdue: doc.status === VoucherStatus.POSTED && isOverdue(doc.dueDate, doc.balance),
        status: doc.status,
        createdBy: userRefOf(doc.createdBy as UserSnapshot | null),
        createdAt: doc.createdAt ?? null,
        updatedBy: userRefOf(doc.updatedBy as UserSnapshot | null),
        updatedAt: doc.updatedAt ?? null,
        commentCount: comments.get(doc._id.toString()) ?? 0,
      })),
      page,
      pageSize,
      summary: {
        count: summaryRows[0]?.count ?? 0,
        netTotal: round2(summaryRows[0]?.netTotal ?? 0),
        outstanding: round2(summaryRows[0]?.outstanding ?? 0),
      },
    };
  }

  /**
   * Net sales (before VAT, which is 0) of posted non-VAT invoices dated dateFrom..dateTo (date-only
   * bounds cover whole days). Kept apart from taxable sales: for the VAT report, which must not count them.
   */
  async nonVatSalesTotal(dateFrom?: string, dateTo?: string): Promise<number> {
    const range: { $gte?: Date; $lte?: Date } = {};
    if (dateFrom) range.$gte = new Date(dateFrom);
    if (dateTo) range.$lte = endOfDayIfDateOnly(dateTo);
    const [row] = await this.model
      .aggregate<{ total: number }>([
        {
          $match: {
            invoiceKind: 'non_vat',
            status: VoucherStatus.POSTED,
            ...(dateFrom || dateTo ? { voucherDate: range } : {}),
          },
        },
        { $group: { _id: null, total: { $sum: '$taxableTotal' } } },
      ])
      .exec();
    return round2(row?.total ?? 0);
  }

  async findById(id: string, viewer?: Viewer): Promise<SalesInvoiceDocument> {
    assertValidId(id);
    const doc = await this.model.findOne(withScope({ _id: new Types.ObjectId(id) }, scopeOf(viewer))).exec();
    if (!doc) {
      throw new NotFoundException(`${LABEL} ${id} not found`);
    }
    return doc;
  }

  /** The invoice with derived overdue and its allocations (active and reversed). */
  async detail(id: string, viewer: Viewer) {
    const doc = await this.findById(id, viewer);
    return {
      ...this.view(doc, viewer),
      overdue: doc.status === VoucherStatus.POSTED && isOverdue(doc.dueDate, doc.balance),
      allocations: await this.allocations.forTarget(AllocationTargetType.SALES_INVOICE, doc._id),
    };
  }

  /** The invoice as returned by the API: line costs only with products:view-cost. */
  view(doc: SalesInvoiceDocument, viewer: Viewer) {
    const plain = doc.toObject();
    if (hasPermission(viewer, Permission.PRODUCTS_VIEW_COST)) return plain;
    const { costTotal: _costTotal, margin: _margin, ...invoice } = plain;
    return {
      ...invoice,
      lines: plain.lines.map(({ unitCost: _unitCost, costAmount: _costAmount, uncosted: _uncosted, ...line }) => line),
    };
  }

  async create(dto: CreateSalesInvoiceDto, actor: Viewer): Promise<SalesInvoiceDocument> {
    const locationId = resolveLocation(actor, dto.locationId);
    const soldById = resolveCollectorId(actor, dto.soldById);
    const kind = dto.invoiceKind ?? 'tax';
    assertKindPermission(actor, kind, Permission.NON_VAT_INVOICES_CREATE, 'create');

    return runInTransaction(this.connection, async (session) => {
      const seller = await this.usersService.findEligibleCollector(soldById, Permission.SALES_INVOICES_CREATE, session);
      const prepared = await this.prepare({ ...dto, locationId }, actor, true, session);
      const customer = (await this.partyModel.findById(prepared.customerId).session(session).exec())!;
      const paid = round2(dto.payNow?.amount ?? 0);
      if (paid > prepared.netTotal + TOLERANCE) {
        throw new BadRequestException(
          `Paid now (${paid.toFixed(2)}) is more than the invoice total ${prepared.netTotal.toFixed(2)}`,
        );
      }
      if (customer.systemKey === CASH_CUSTOMER_KEY && Math.abs(paid - prepared.netTotal) > TOLERANCE) {
        throw new BadRequestException(
          `${customer.name} can't buy on credit: payNow.amount must equal the invoice total ${prepared.netTotal.toFixed(2)}`,
        );
      }

      const voucherNo = await this.sequenceService.nextCode(kind === 'non_vat' ? NON_VAT_SEQUENCE : SEQUENCE, session);
      const now = new Date();
      const [created] = await this.model.create(
        [
          {
            voucherNo,
            ...prepared,
            soldById: seller._id,
            soldByName: seller.name,
            ...unpaid(prepared.netTotal),
            status: VoucherStatus.POSTED,
            createdBy: toUserSnapshot(actor),
            createdAt: now,
          },
        ],
        { session },
      );
      await this.postLedger(created, LedgerEntryKind.POSTING, 'created', session);
      await this.consumeCosts(created, session);
      await this.stockService.post(await this.stockEntriesOf(created, session), actor, session);
      await this.assertCredit(customer, paid, actor, dto.acknowledgeCredit, session);
      await this.record(created, AuditAction.CREATED, actor, now, session);

      if (dto.payNow && paid > 0) {
        const { method, accountId, amount: _amount, ...cheque } = dto.payNow;
        const receipt = await this.cashReceipts.create(
          {
            voucherDate: dto.date,
            cashAccountId: accountId,
            paymentMethod: method,
            ...cheque,
            collectedById: seller._id.toString(),
            comments: `Paid at sale ${voucherNo}`,
            lines: [
              {
                accountId: customer.ledgerAccountId.toString(),
                amount: paid,
                narration: `${voucherNo} payment`,
                allocations: [{ targetType: AllocationTargetType.SALES_INVOICE, targetId: created._id.toString(), amount: paid }],
              },
            ],
          },
          actor,
          session,
        );
        await this.model.updateOne({ _id: created._id }, { $set: { paymentReceiptId: receipt._id } }, { session }).exec();
      }
      return (await this.model.findById(created._id).session(session).exec())!;
    });
  }

  /** Reverses the old posting and posts the new one; refused once any payment is applied. */
  async update(id: string, dto: UpdateSalesInvoiceDto, actor: Viewer): Promise<SalesInvoiceDocument> {
    if (dto.locationId !== undefined) assertLocationAllowed(actor, dto.locationId);
    const soldById = dto.soldById !== undefined ? resolveCollectorId(actor, dto.soldById) : undefined;

    return runInTransaction(this.connection, async (session) => {
      const existing = await this.load(id, scopeOf(actor), session);
      assertKindPermission(actor, existing.invoiceKind ?? 'tax', Permission.NON_VAT_INVOICES_EDIT, 'edit');
      assertNotCancelled(existing, 'edited');
      assertNoReturns(existing, 'edited');
      await this.allocations.assertNoActive(
        AllocationTargetType.SALES_INVOICE,
        existing._id,
        `${LABEL} ${existing.voucherNo}`,
        'edited',
        session,
      );
      const date = dto.date ?? existing.voucherDate.toISOString();
      const customerId = dto.customerId ?? existing.customerId.toString();
      const dateOrCustomerChanged =
        day(new Date(date)) !== day(existing.voucherDate) || customerId !== existing.customerId.toString();
      const next = await this.prepare(
        {
          date,
          customerId,
          locationId: dto.locationId ?? existing.locationId.toString(),
          // A new date or customer recomputes the default due date unless one is sent.
          dueDate: dto.dueDate ?? (dateOrCustomerChanged ? undefined : existing.dueDate.toISOString()),
          remarks: dto.remarks !== undefined ? dto.remarks : existing.remarks,
          lines: dto.lines ?? existing.lines.map(toInput),
          invoiceKind: existing.invoiceKind ?? 'tax',
          discountType: dto.discountType ?? existing.discountType,
          discountValue: dto.discountValue ?? existing.discountValue,
        },
        actor,
        dto.lines !== undefined || dto.discountType !== undefined || dto.discountValue !== undefined,
        session,
      );
      const customer = (await this.partyModel.findById(next.customerId).session(session).exec())!;
      if (customer.systemKey === CASH_CUSTOMER_KEY) {
        throw new BadRequestException(`Sales to ${customer.name} must be paid in full at sale; cancel and re-enter instead`);
      }
      let seller = { id: existing.soldById, name: existing.soldByName };
      if (soldById && soldById !== existing.soldById.toString()) {
        const user = await this.usersService.findEligibleCollector(soldById, Permission.SALES_INVOICES_CREATE, session);
        seller = { id: user._id, name: user.name };
      }

      const changes = await this.diff(existing, { ...next, soldByName: seller.name }, session);
      if (changes.length === 0) {
        throw new BadRequestException('No changes to save');
      }

      const stockReversals = await this.stockService.reversalsOf(SALES_INVOICE_ENTITY_TYPE, existing._id, session);
      await this.costService.reverseAll({ voucherType: SALES_INVOICE_ENTITY_TYPE, voucherId: existing._id }, session);
      await this.postLedger(existing, LedgerEntryKind.REVERSAL, 'updated', session);
      const now = new Date();
      existing.set({
        ...next,
        soldById: seller.id,
        soldByName: seller.name,
        ...unpaid(next.netTotal),
        updatedBy: toUserSnapshot(actor),
        updatedAt: now,
      });
      await existing.save({ session });
      await this.postLedger(existing, LedgerEntryKind.POSTING, 'updated', session);
      await this.consumeCosts(existing, session);
      await this.stockService.post([...stockReversals, ...(await this.stockEntriesOf(existing, session))], actor, session);
      await this.assertCredit(customer, 0, actor, dto.acknowledgeCredit, session);
      await this.record(existing, AuditAction.UPDATED, actor, now, session, { changes, reason: dto.changeNote });
      return existing;
    });
  }

  /**
   * Cancels the pay-at-sale receipt first (refused if it was handed over or
   * its cheque deposited), then reverses ledger and stock.
   */
  async cancel(id: string, dto: CancelSalesInvoiceDto, actor: Viewer): Promise<SalesInvoiceDocument> {
    const reason = dto.reason.trim();

    return runInTransaction(this.connection, async (session) => {
      const found = await this.load(id, scopeOf(actor), session);
      assertKindPermission(actor, found.invoiceKind ?? 'tax', Permission.NON_VAT_INVOICES_CANCEL, 'cancel');
      assertNotCancelled(found, 'cancelled again');
      assertNoReturns(found, 'cancelled');
      if (found.paymentReceiptId) {
        const receipt = await this.receiptModel.findById(found.paymentReceiptId).session(session).exec();
        if (receipt && receipt.status !== VoucherStatus.CANCELLED) {
          try {
            await this.cashReceipts.cancel(
              receipt._id.toString(),
              { reason: `${LABEL} ${found.voucherNo} cancelled: ${reason}` },
              actor,
              session,
            );
          } catch (error) {
            if (!(error instanceof HttpException) || error.getStatus() >= 500) throw error;
            throw new ConflictException(
              `${LABEL} ${found.voucherNo} can't be cancelled because its payment ${receipt.voucherNo} can't be: ${error.message}`,
            );
          }
        }
      }
      // Re-read: cancelling the receipt moved the invoice's paid amount.
      const existing = await this.load(id, null, session);
      await this.allocations.assertNoActive(
        AllocationTargetType.SALES_INVOICE,
        existing._id,
        `${LABEL} ${existing.voucherNo}`,
        'cancelled',
        session,
      );
      await this.stockService.post(
        await this.stockService.reversalsOf(SALES_INVOICE_ENTITY_TYPE, existing._id, session),
        actor,
        session,
        { strict: true },
      );
      await this.costService.reverseAll({ voucherType: SALES_INVOICE_ENTITY_TYPE, voucherId: existing._id }, session);
      await this.postLedger(existing, LedgerEntryKind.REVERSAL, 'cancelled', session);
      const now = new Date();
      existing.status = VoucherStatus.CANCELLED;
      existing.cancelledBy = toUserSnapshot(actor);
      existing.cancelledAt = now;
      existing.cancelReason = reason;
      await existing.save({ session });
      await this.record(existing, AuditAction.CANCELLED, actor, now, session, {
        changes: [{ field: 'status', label: 'Status', from: VoucherStatus.POSTED, to: VoucherStatus.CANCELLED }],
        reason,
      });
      return existing;
    });
  }

  /** TAX INVOICE PDF (?size, else the company default): ORIGINAL then DUPLICATEs, every print audited. */
  async print(id: string, actor: Viewer, requestedSize?: string): Promise<PrintedVoucher> {
    assertValidId(id);
    // Fetched before the transaction: it may call out to file storage.
    const { settings, logoDataUrl } = await this.companyService.getForPrinting();
    // Validated before any print side effect; a non-VAT invoice's default size is chosen once it is loaded.
    const defaultSize = printLayout.resolveSize(requestedSize, 'taxInvoice', settings.printDefaults);

    return runInTransaction(this.connection, async (session) => {
      const doc = await this.model
        .findOneAndUpdate(
          withScope({ _id: new Types.ObjectId(id) }, scopeOf(actor)),
          { $inc: { printCount: 1 } },
          { returnDocument: 'after', session },
        )
        .exec();
      if (!doc) {
        throw new NotFoundException(`${LABEL} ${id} not found`);
      }
      const customer = await this.partyModel
        .findById(doc.customerId)
        .select('code name vatNumber')
        .session(session)
        .lean()
        .exec();
      const locations = await this.namesOf(this.locationModel, [doc.locationId], session);
      const products = await this.productModel
        .find({ _id: { $in: doc.lines.map((line) => line.productId) } })
        .select('code name')
        .session(session)
        .lean()
        .exec();
      const productName = (productId: Types.ObjectId) => {
        const product = products.find((candidate) => candidate._id.equals(productId));
        return product ? `${product.code} ${product.name}` : productId.toString();
      };
      const printedAt = new Date();
      const copyNumber = doc.printCount;
      // A non-VAT invoice prints as a plain INVOICE: no logo, company name, address, TRN or VAT.
      const nonVat = doc.invoiceKind === 'non_vat';
      const size = nonVat ? printLayout.resolveSize(requestedSize, 'nonVatInvoice', settings.printDefaults) : defaultSize;

      const definition = (nonVat ? buildPlainInvoicePdf : buildVoucherPdf)(
        {
          company: nonVat
            ? {
                legalName: '',
                addressLines: [],
                phone: null,
                trn: null,
                footerText: null,
                plainHeaderText: settings.nonVatHeaderText,
                currencyCode: settings.currencyCode,
                logoDataUrl: null,
              }
            : {
                legalName: settings.legalName,
                addressLines: [
                  settings.addressLine1,
                  settings.addressLine2,
                  [settings.city, settings.country].filter(Boolean).join(', '),
                ].filter((line): line is string => Boolean(line)),
                phone: settings.phone,
                trn: settings.trn,
                footerText: settings.receiptFooterText,
                currencyCode: settings.currencyCode,
                logoDataUrl,
              },
          voucher: {
            voucherNo: doc.voucherNo,
            voucherDate: doc.voucherDate,
            headerAccountName: customer ? (nonVat ? customer.name : `${customer.code} ${customer.name}`) : doc.customerId.toString(),
            collectedByName: doc.soldByName,
            extraInfo: nonVat
              ? []
              : [
                  { label: 'Customer TRN', value: customer?.vatNumber ?? '-' },
                  { label: 'Location', value: locations.get(doc.locationId.toString()) ?? '-' },
                  { label: 'Due Date', value: formatVoucherDate(doc.dueDate) },
                ],
            paymentMethod: 'cash',
            paymentReference: null,
            lines: [],
            items: itemDocument(
              doc.lines.map((line) => ({
                product: productName(line.productId),
                qty: line.qty,
                rate: line.rate,
                discount: line.discount,
                allocatedDiscount: line.allocatedDiscount ?? 0,
                vatRate: line.vatRate,
                amount: line.amount,
                vat: line.vat,
              })),
              true,
            ),
            grossTotal: doc.taxableTotal,
            totalTax: doc.totalTax,
            grandTotal: doc.netTotal,
            comments: doc.remarks,
            preparedBy: doc.createdBy ? { name: doc.createdBy.name, at: doc.createdAt } : null,
            cancelled:
              doc.status === VoucherStatus.CANCELLED
                ? { reason: doc.cancelReason, by: doc.cancelledBy?.name ?? null, at: doc.cancelledAt }
                : null,
          },
          copyNumber,
          printedBy: actor.name,
          printedAt,
          size,
        },
        {
          titles: nonVat ? { cash: 'INVOICE', bank: 'INVOICE' } : { cash: 'TAX INVOICE', bank: 'TAX INVOICE' },
          documentTitle: nonVat ? 'Invoice' : 'Tax Invoice',
          headerLabel: 'Customer',
          counterpartyColumn: 'Product',
          signatures: ['Salesman', 'Received by'],
          collectorLabel: 'Salesman',
        },
      );
      const buffer = await renderPdf(definition);
      await this.auditService.record(
        {
          entityType: SALES_INVOICE_ENTITY_TYPE,
          entityId: doc._id,
          entityRef: doc.voucherNo,
          action: AuditAction.PRINTED,
          actor,
          changes: [
            { field: 'copy', label: 'Copy', from: null, to: copyLabel(copyNumber) },
            { field: 'size', label: 'Size', from: null, to: size },
          ],
          at: printedAt,
        },
        session,
      );
      return { buffer, filename: `${doc.voucherNo}.pdf`, copyNumber, definition };
    });
  }

  /**
   * Checks customer, location and products, and prices the lines: rate
   * defaults to the sale price, amount = qty x rate - discount, VAT per line.
   * `checkPricing`: the lines were sent now, so price overrides and discounts
   * need their permissions.
   */
  private async prepare(input: PrepareInput, actor: Viewer, checkPricing: boolean, session: ClientSession): Promise<Prepared> {
    const customer = await this.partyModel.findById(asId(input.customerId, 'customer')).session(session).exec();
    if (!customer || customer.kind !== PartyKind.CUSTOMER) {
      throw new NotFoundException(`Customer ${input.customerId} not found`);
    }
    if (customer.status !== PartyStatus.ACTIVE) {
      throw new BadRequestException(`Customer ${customer.code} (${customer.name}) is inactive`);
    }
    await this.stockService.assertHoldsStock([], [input.locationId], session);

    const priced = await this.price(input, actor, checkPricing, session);
    const voucherDate = new Date(input.date);
    return {
      invoiceKind: input.invoiceKind ?? 'tax',
      voucherDate,
      customerId: customer._id,
      customerAccountId: customer.ledgerAccountId,
      locationId: new Types.ObjectId(input.locationId),
      dueDate: input.dueDate ? new Date(input.dueDate) : new Date(voucherDate.getTime() + (customer.creditDays ?? 0) * DAY_MS),
      remarks: input.remarks?.trim() || null,
      ...priced,
    };
  }

  /** POST /sales-invoices/preview: the same pricing and checks as a save, nothing stored. */
  async preview(dto: PreviewSalesInvoiceDto, actor: Viewer) {
    assertKindPermission(actor, dto.invoiceKind ?? 'tax', Permission.NON_VAT_INVOICES_CREATE, 'create');
    const priced = await this.price(dto, actor, true);
    return {
      lines: priced.lines.map((line) => ({
        productId: line.productId.toString(),
        qty: line.qty,
        rate: line.rate,
        discountType: line.discountType,
        discountValue: line.discountValue,
        discountAmount: line.discount,
        allocatedDiscount: line.allocatedDiscount,
        taxable: line.amount,
        vatRate: line.vatRate,
        vat: line.vat,
        net: line.netAmount,
      })),
      totals: {
        gross: priced.grossTotal,
        lineDiscounts: priced.totalDiscount,
        invoiceDiscount: priced.invoiceDiscount,
        taxable: priced.taxableTotal,
        tax: priced.totalTax,
        net: priced.netTotal,
      },
    };
  }

  /**
   * Prices the lines: rate defaults to the sale price; line discount (amount or
   * percent), then the invoice discount spread over the lines; VAT per line on
   * what is left. `checkPricing`: the lines/discount were sent now, so price
   * overrides, discounts and the role's maxDiscountPercent apply.
   */
  private async price(
    input: Pick<PrepareInput, 'lines' | 'discountType' | 'discountValue' | 'invoiceKind'>,
    actor: Viewer,
    checkPricing: boolean,
    session?: ClientSession,
  ) {
    const products = await this.productModel
      .find({ _id: { $in: input.lines.map((line) => asId(line.productId, 'product')) } })
      .select('code name status salePrice vatRate')
      .session(session ?? null)
      .lean()
      .exec();
    const nonVat = input.invoiceKind === 'non_vat';
    const headerType = input.discountType ?? 'amount';
    const headerValue = round2(input.discountValue ?? 0);
    const rows = input.lines.map((line, index) => {
      const product = products.find((candidate) => candidate._id.toString() === line.productId);
      if (!product) {
        throw new NotFoundException(`Line ${index + 1}: product ${line.productId} not found`);
      }
      const rate = line.rate ?? product.salePrice;
      const discountType = line.discountType ?? 'amount';
      const discountValue = round2(line.discountValue ?? line.discount ?? 0);
      if (checkPricing) {
        if (product.status !== ProductStatus.ACTIVE) {
          throw new BadRequestException(`Line ${index + 1}: ${product.code} (${product.name}) is inactive`);
        }
        if (rate !== product.salePrice && !hasPermission(actor, Permission.SALES_OVERRIDE_PRICE)) {
          throw new ForbiddenException(
            `Line ${index + 1}: you may not change the price of ${product.code} (${product.name}) from ${product.salePrice}`,
          );
        }
      }
      if (nonVat && line.vatRate) {
        throw new BadRequestException(`Line ${index + 1}: a non-VAT invoice can't carry VAT (vatRate must be 0)`);
      }
      const qty = roundQty(line.qty);
      if (!(qty > 0) || rate < 0 || discountValue < 0) {
        throw new BadRequestException(`Line ${index + 1}: quantity must be above 0, rate and discount 0 or more`);
      }
      if (discountType === 'percent' && discountValue > 100) {
        throw new BadRequestException(`Line ${index + 1}: a percent discount can't be above 100`);
      }
      return { product, qty, rate, discountType, discountValue, vatRate: nonVat ? 0 : (line.vatRate ?? product.vatRate) };
    });
    if (headerType === 'percent' && headerValue > 100) {
      throw new BadRequestException("The invoice discount can't be above 100%");
    }
    const priced = priceInvoice(rows, { discountType: headerType, discountValue: headerValue });
    if (checkPricing && priced.lineDiscounts + priced.invoiceDiscount > 0) {
      if (!hasPermission(actor, Permission.SALES_DISCOUNT)) {
        throw new ForbiddenException('You may not give a discount');
      }
      const limit = actor.maxDiscountPercent;
      if (limit != null && priced.grossTotal > 0) {
        const percent = ((priced.lineDiscounts + priced.invoiceDiscount) / priced.grossTotal) * 100;
        if (percent > limit + TOLERANCE) {
          throw new ForbiddenException(
            `Total discount is ${round2(percent)}% of the invoice; your role allows up to ${limit}%`,
          );
        }
      }
    }
    const lines = rows.map((row, index): SalesInvoiceLine => {
      const line = priced.lines[index];
      return {
        productId: row.product._id,
        qty: row.qty,
        rate: row.rate,
        discount: line.discountAmount,
        discountType: row.discountType,
        discountValue: row.discountValue,
        allocatedDiscount: line.allocatedDiscount,
        amount: line.taxable,
        vatRate: row.vatRate,
        vat: line.vat,
        netAmount: line.net,
        unitCost: 0,
        costAmount: 0,
      };
    });
    return {
      lines,
      grossTotal: priced.grossTotal,
      totalDiscount: priced.lineDiscounts,
      discountType: headerType,
      discountValue: headerValue,
      invoiceDiscount: priced.invoiceDiscount,
      taxableTotal: priced.taxableTotal,
      totalTax: priced.totalTax,
      netTotal: priced.netTotal,
    };
  }

  /**
   * After posting: what the customer would owe (balance less what is paid
   * now) may not exceed a set credit limit, unless a user with
   * sales:override-credit confirms with acknowledgeCredit.
   */
  private async assertCredit(
    customer: PartyDocument,
    paidNow: number,
    actor: Viewer,
    acknowledged: boolean | undefined,
    session: ClientSession,
  ): Promise<void> {
    const limit = customer.creditLimit ?? 0;
    if (!(limit > 0)) return;
    const accountId = customer.ledgerAccountId.toString();
    const balance = (await this.ledgerAccountService.getBalances([accountId], session)).get(accountId) ?? 0;
    const owed = round2(balance - paidNow);
    if (owed <= limit + TOLERANCE) return;
    const message = `${customer.code} (${customer.name}) would owe ${owed.toFixed(2)}, over the credit limit of ${limit.toFixed(2)}`;
    if (!hasPermission(actor, Permission.SALES_OVERRIDE_CREDIT)) {
      throw new ConflictException(`${message}; a user with sales:override-credit can approve it`);
    }
    if (!acknowledged) {
      throw new ConflictException(`${message}. Resend with acknowledgeCredit: true to save anyway.`);
    }
  }

  /**
   * Dr customer (net total), Cr Sales (net before VAT), Cr VAT Output (tax); a reversal swaps the sides.
   * Non-VAT: Cr Sales (Non-VAT) instead, and VAT Output is never touched.
   */
  private async postLedger(doc: SalesInvoiceDocument, kind: LedgerEntryKind, cause: string, session: ClientSession) {
    const nonVat = doc.invoiceKind === 'non_vat';
    const salesAccount = nonVat ? SYSTEM_ACCOUNTS.SALES_NON_VAT : SYSTEM_ACCOUNTS.SALES;
    const sales = await this.ledgerAccountService.ensureSystemAccount(
      salesAccount.key,
      salesAccount.name,
      salesAccount.type,
      session,
    );
    const vatOutput = nonVat
      ? null
      : await this.ledgerAccountService.ensureSystemAccount(
          SYSTEM_ACCOUNTS.VAT_OUTPUT.key,
          SYSTEM_ACCOUNTS.VAT_OUTPUT.name,
          SYSTEM_ACCOUNTS.VAT_OUTPUT.type,
          session,
        );
    const narration = doc.voucherNo;
    await this.posting.postEntries(
      { entityType: SALES_INVOICE_ENTITY_TYPE, id: doc._id, voucherNo: doc.voucherNo, voucherDate: doc.voucherDate },
      [
        { accountId: doc.customerAccountId.toString(), debit: doc.netTotal, credit: 0, narration },
        { accountId: sales._id.toString(), debit: 0, credit: doc.taxableTotal, narration },
        ...(vatOutput ? [{ accountId: vatOutput._id.toString(), debit: 0, credit: doc.totalTax, narration }] : []),
      ],
      kind,
      cause,
      session,
    );
  }

  private async stockedIdsOf(doc: SalesInvoiceDocument, session: ClientSession): Promise<Set<string>> {
    const stocked = await this.productModel
      .find({ _id: { $in: doc.lines.map((line) => line.productId) }, type: { $in: STOCK_PRODUCT_TYPES } })
      .select('_id')
      .session(session)
      .lean()
      .exec();
    return new Set(stocked.map((product) => product._id.toString()));
  }

  /**
   * Takes each stock/bundle line from the FIFO layers and stores its cost on
   * the line, plus costTotal and margin on the invoice. Non-stock lines cost nothing.
   */
  private async consumeCosts(doc: SalesInvoiceDocument, session: ClientSession): Promise<void> {
    const stockedIds = await this.stockedIdsOf(doc, session);
    for (const line of doc.lines) {
      if (!stockedIds.has(line.productId.toString())) continue;
      const cost = await this.costService.consume(
        line.productId,
        line.qty,
        { voucherType: SALES_INVOICE_ENTITY_TYPE, voucherId: doc._id, voucherNo: doc.voucherNo, lineId: line._id },
        session,
      );
      line.unitCost = cost.avgUnitCost;
      line.costAmount = cost.totalCost;
      line.uncosted = cost.uncosted;
    }
    doc.costTotal = sum2(doc.lines.map((line) => line.costAmount));
    doc.margin = round2(doc.taxableTotal - doc.costTotal);
    await doc.save({ session });
  }

  /** Stock-out per stock/bundle line; non-stock lines post accounts only. */
  private async stockEntriesOf(doc: SalesInvoiceDocument, session: ClientSession): Promise<StockEntryInput[]> {
    const stockedIds = await this.stockedIdsOf(doc, session);
    return doc.lines
      .filter((line) => stockedIds.has(line.productId.toString()))
      .map((line) => ({
        productId: line.productId,
        locationId: doc.locationId,
        qty: -line.qty,
        date: doc.voucherDate,
        voucherType: SALES_INVOICE_ENTITY_TYPE,
        voucherId: doc._id,
        voucherNo: doc.voucherNo,
        unitCost: line.unitCost,
        costing: 'consume' as const,
      }));
  }

  /** Field diff for the audit: header fields by display value, and each product's line. */
  private async diff(
    before: SalesInvoiceDocument,
    after: Prepared & { soldByName: string },
    session: ClientSession,
  ): Promise<AuditChange[]> {
    const parties = await this.namesOf(this.partyModel, [before.customerId, after.customerId], session);
    const locations = await this.namesOf(this.locationModel, [before.locationId, after.locationId], session);
    const header = (doc: (Prepared & { soldByName: string }) | SalesInvoiceDocument) => ({
      date: day(doc.voucherDate),
      customer: parties.get(doc.customerId.toString()) ?? doc.customerId.toString(),
      location: locations.get(doc.locationId.toString()) ?? doc.locationId.toString(),
      soldBy: doc.soldByName,
      dueDate: day(doc.dueDate),
      remarks: doc.remarks,
      invoiceDiscount: `${doc.discountType ?? 'amount'} ${doc.discountValue ?? 0}`,
      netTotal: doc.netTotal,
    });
    const changes = diffFields(header(before), header(after), [
      { key: 'date', label: 'Date' },
      { key: 'customer', label: 'Customer' },
      { key: 'location', label: 'Location' },
      { key: 'soldBy', label: 'Sold By' },
      { key: 'dueDate', label: 'Due Date' },
      { key: 'remarks', label: 'Remarks' },
      { key: 'invoiceDiscount', label: 'Invoice discount' },
      { key: 'netTotal', label: 'Net total' },
    ]);

    const describe = (lines: readonly SalesInvoiceLine[]) => {
      const byProduct = new Map<string, string[]>();
      for (const line of lines) {
        const text = `${line.qty} @ ${line.rate}${line.discount > 0 ? ` - ${line.discount.toFixed(2)}` : ''}${(line.allocatedDiscount ?? 0) > 0 ? ` - ${line.allocatedDiscount!.toFixed(2)} spread` : ''}, VAT ${line.vatRate}%`;
        byProduct.set(line.productId.toString(), [...(byProduct.get(line.productId.toString()) ?? []), text]);
      }
      return new Map([...byProduct].map(([id, texts]) => [id, texts.join(' + ')]));
    };
    const from = describe(before.lines);
    const to = describe(after.lines);
    const productIds = [...new Set([...from.keys(), ...to.keys()])].filter((id) => from.get(id) !== to.get(id));
    const names = await this.namesOf(
      this.productModel,
      productIds.map((id) => new Types.ObjectId(id)),
      session,
    );
    for (const productId of productIds) {
      changes.push({
        field: 'lines',
        label: names.get(productId) ?? productId,
        from: from.get(productId) ?? null,
        to: to.get(productId) ?? null,
      });
    }
    return changes;
  }

  private async namesOf(
    model: Model<LocationDocument> | Model<PartyDocument> | Model<ProductDocument>,
    ids: Types.ObjectId[],
    session?: ClientSession,
  ): Promise<Map<string, string>> {
    const docs = await (model as unknown as Model<{ name: string }>)
      .find({ _id: { $in: ids } })
      .select('name')
      .session(session ?? null)
      .lean()
      .exec();
    return new Map(docs.map((doc) => [doc._id.toString(), doc.name]));
  }

  private async load(id: string, scope: Record<string, unknown> | null, session: ClientSession) {
    assertValidId(id);
    const doc = await this.model
      .findOne(withScope({ _id: new Types.ObjectId(id) }, scope))
      .session(session)
      .exec();
    if (!doc) {
      throw new NotFoundException(`${LABEL} ${id} not found`);
    }
    return doc;
  }

  private record(
    doc: SalesInvoiceDocument,
    action: AuditAction,
    actor: Viewer,
    at: Date,
    session: ClientSession,
    extra: { changes?: AuditChange[]; reason?: string } = {},
  ) {
    return this.auditService.record(
      { entityType: SALES_INVOICE_ENTITY_TYPE, entityId: doc._id, entityRef: doc.voucherNo, action, actor, at, ...extra },
      session,
    );
  }
}

/** "own"-scoped users: only invoices they created or sold. */
export function salesScopeOf(user: Viewer | undefined): Record<string, unknown> | null {
  if (!isOwnScope(user)) return null;
  const me = new Types.ObjectId(user.id);
  return { $or: [{ 'createdBy.id': me }, { soldById: me }] };
}

/** salesScopeOf plus: users without non-vat-invoices:read never see non-VAT invoices (404). */
function scopeOf(user: Viewer | undefined): Record<string, unknown> | null {
  const own = salesScopeOf(user);
  if (!user || hasPermission(user, Permission.NON_VAT_INVOICES_READ)) return own;
  const taxOnly = { invoiceKind: { $ne: 'non_vat' } };
  return own ? { $and: [own, taxOnly] } : taxOnly;
}

/** Non-VAT invoices need their own permission on top of the sales-invoices one the route asks for. */
function assertKindPermission(user: Viewer | undefined, kind: InvoiceKind, permission: Permission, action: string): void {
  if (kind === 'non_vat' && user && !hasPermission(user, permission)) {
    throw new ForbiddenException(`You may not ${action} non-VAT invoices`);
  }
}

/** The sale's location; an "own"-scoped user with a single allowed location gets it by default. */
function resolveLocation(user: Viewer, locationId: string | undefined): string {
  const allowed = stockLocationScope(user);
  const resolved = locationId ?? (allowed?.length === 1 ? allowed[0] : undefined);
  if (!resolved) {
    throw new BadRequestException('locationId is required');
  }
  assertLocationAllowed(user, resolved);
  return resolved;
}

function assertLocationAllowed(user: Viewer, locationId: string): void {
  const allowed = stockLocationScope(user);
  if (allowed && !allowed.includes(locationId)) {
    throw new ForbiddenException('You may not sell from this location');
  }
}

/** Payment fields of an invoice with nothing allocated (edit is blocked while anything is). */
function unpaid(netTotal: number) {
  return { paidAmount: 0, balance: netTotal, paymentStatus: paymentStatusOf(netTotal, 0) };
}

function toInput(line: SalesInvoiceLine): SalesInvoiceLineDto {
  return {
    productId: line.productId.toString(),
    qty: line.qty,
    rate: line.rate,
    discountType: line.discountType ?? 'amount',
    discountValue: line.discountValue || line.discount,
    vatRate: line.vatRate,
  };
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function asId(id: string, what: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestException(`${what} id "${id}" is not a valid id`);
  }
  return new Types.ObjectId(id);
}

function assertNotCancelled(doc: SalesInvoiceDocument, action: string): void {
  if (doc.status === VoucherStatus.CANCELLED) {
    throw new BadRequestException(`${LABEL} ${doc.voucherNo} is cancelled and cannot be ${action}`);
  }
}

/** An invoice with active returns is locked: cancel the returns first. */
function assertNoReturns(doc: SalesInvoiceDocument, action: string): void {
  if ((doc.returnedQty ?? 0) > 0) {
    throw new ConflictException(
      `${LABEL} ${doc.voucherNo} has sales returns (${doc.returnedQty} returned); cancel those before it can be ${action}`,
    );
  }
}

function assertValidId(id: string): void {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestException(`${LABEL} id "${id}" is not a valid id`);
  }
}

/** A date-only filter bound covers the whole day. */
function endOfDayIfDateOnly(value: string): Date {
  const date = new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
}
