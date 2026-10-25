import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import {
  PURCHASE_INVOICE_ENTITY_TYPE,
  PurchaseInvoice,
  PurchaseInvoiceDocument,
  type PurchaseInvoiceLine,
} from './schemas/purchase-invoice.schema.js';
import {
  CancelPurchaseInvoiceDto,
  CreatePurchaseInvoiceDto,
  PurchaseInvoiceLineDto,
  PurchaseInvoiceQueryDto,
  UpdatePurchaseInvoiceDto,
} from './dto/purchase-invoice.dto.js';
import { STOCK_PRODUCT_TYPES, StockService, roundQty, stockLocationScope, type StockEntryInput } from '../../stock/stock.service.js';
import { PRODUCT_ENTITY_TYPE, Product, ProductDocument } from '../../product/products/schemas/product.schema.js';
import { ProductUsageRegistry } from '../../product/products/product-usage.registry.js';
import { Party, PartyDocument, PartyKind, PartyStatus } from '../../party/schemas/party.schema.js';
import { Location, LocationDocument } from '../../location/schemas/location.schema.js';
import { VoucherStatus } from '../../accounting/vouchers/schemas/voucher.schema.js';
import { LedgerEntryKind } from '../../accounting/vouchers/schemas/ledger-entry.schema.js';
import { VoucherPostingService } from '../../accounting/vouchers/voucher-posting.service.js';
import { buildVoucherPdf, copyLabel, formatVoucherDate } from '../../accounting/vouchers/voucher-pdf.js';
import type { PrintedVoucher } from '../../accounting/vouchers/voucher-print.service.js';
import { withScope } from '../../accounting/vouchers/data-scope.js';
import { LedgerAccountService } from '../../accounting/ledger-accounts/ledger-account.service.js';
import { LedgerAccountUsageRegistry } from '../../accounting/ledger-accounts/ledger-account-usage.registry.js';
import { SYSTEM_ACCOUNTS } from '../../accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { CompanyService } from '../../company/company.service.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { escapeRegExp } from '../../sequence/code-sequence.js';
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
import { AllocationService } from '../../accounting/allocations/allocation.service.js';
import {
  AllocationTargetType,
  isOverdue,
  paymentStatusOf,
} from '../../accounting/allocations/schemas/allocation.schema.js';

type Viewer = AuthenticatedUser;

const SEQUENCE = { key: 'purchase-invoice', prefix: 'PI-', width: 4 };
const LABEL = 'Purchase invoice';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Everything a save writes onto the invoice, checked and priced. */
interface Prepared {
  voucherDate: Date;
  supplierId: Types.ObjectId;
  supplierAccountId: Types.ObjectId;
  locationId: Types.ObjectId;
  billNo: string;
  billDate: Date | null;
  dueDate: Date;
  remarks: string | null;
  attachmentFileRefs: Types.ObjectId[];
  updatePurchasePrice: boolean;
  lines: PurchaseInvoiceLine[];
  grossTotal: number;
  totalDiscount: number;
  taxableTotal: number;
  totalTax: number;
  netTotal: number;
}

/**
 * Purchase invoices. One transaction per save: number, ledger entries
 * (Dr Purchases, Dr VAT Input, Cr supplier), stock-in per stock/bundle line,
 * purchase price updates and audit. Edit = reverse + repost; edit and cancel
 * are strict on stock (refused if the bought stock was already used).
 * "own"-scoped users see and enter only their allowedLocationIds.
 */
@Injectable()
export class PurchaseInvoiceService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(PurchaseInvoice.name) private readonly model: Model<PurchaseInvoiceDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(Party.name) private readonly partyModel: Model<PartyDocument>,
    @InjectModel(Location.name) private readonly locationModel: Model<LocationDocument>,
    private readonly stockService: StockService,
    private readonly posting: VoucherPostingService,
    private readonly ledgerAccountService: LedgerAccountService,
    private readonly sequenceService: SequenceService,
    private readonly auditService: AuditService,
    private readonly commentsService: CommentsService,
    private readonly companyService: CompanyService,
    private readonly allocations: AllocationService,
    entityAccess: EntityAccessRegistry,
    productUsage: ProductUsageRegistry,
    ledgerUsage: LedgerAccountUsageRegistry,
  ) {
    entityAccess.register(PURCHASE_INVOICE_ENTITY_TYPE, {
      exists: async (id, user) => Boolean(await this.model.exists(withScope({ _id: id }, scopeOf(user))).exec()),
      canRead: (user) => hasPermission(user, Permission.PURCHASE_INVOICES_READ),
    });
    productUsage.register('purchase invoices', async (productId, session) =>
      Boolean(
        await this.model
          .exists({ 'lines.productId': productId })
          .session(session ?? null)
          .exec(),
      ),
    );
    // Blocks deleting the supplier (Parties checks its ledger account's usage).
    ledgerUsage.register('purchase invoices', async (accountId, session) =>
      Boolean(
        await this.model
          .exists({ supplierAccountId: accountId })
          .session(session ?? null)
          .exec(),
      ),
    );
  }

  async findAll(query: PurchaseInvoiceQueryDto = {}, viewer?: Viewer) {
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
    if (query.supplierId) filter.supplierId = new Types.ObjectId(query.supplierId);
    if (query.locationId) filter.locationId = new Types.ObjectId(query.locationId);
    const term = query.q?.trim();
    if (term) {
      const pattern = new RegExp(escapeRegExp(term), 'i');
      filter.$or = [{ voucherNo: pattern }, { billNo: pattern }];
    }
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
              // Cancelled invoices owe nothing.
              netTotal: { $sum: { $cond: [{ $eq: ['$status', VoucherStatus.CANCELLED] }, 0, '$netTotal'] } },
              outstanding: { $sum: { $cond: [{ $eq: ['$status', VoucherStatus.CANCELLED] }, 0, '$balance'] } },
            },
          },
        ])
        .exec(),
    ]);
    const [comments, locations, suppliers] = await Promise.all([
      this.commentsService.countByEntityIds(
        PURCHASE_INVOICE_ENTITY_TYPE,
        docs.map((doc) => doc._id),
      ),
      this.namesOf(this.locationModel, docs.map((doc) => doc.locationId)),
      this.namesOf(this.partyModel, docs.map((doc) => doc.supplierId)),
    ]);
    return {
      items: docs.map((doc) => ({
        id: doc._id.toString(),
        voucherNo: doc.voucherNo,
        voucherDate: doc.voucherDate,
        supplier: { id: doc.supplierId.toString(), name: suppliers.get(doc.supplierId.toString()) ?? null },
        location: { id: doc.locationId.toString(), name: locations.get(doc.locationId.toString()) ?? null },
        billNo: doc.billNo,
        billDate: doc.billDate,
        dueDate: doc.dueDate,
        lineCount: doc.lines.length,
        taxableTotal: doc.taxableTotal,
        totalTax: doc.totalTax,
        netTotal: doc.netTotal,
        paidAmount: doc.paidAmount,
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

  async findById(id: string, viewer?: Viewer): Promise<PurchaseInvoiceDocument> {
    assertValidId(id);
    const doc = await this.model.findOne(withScope({ _id: new Types.ObjectId(id) }, scopeOf(viewer))).exec();
    if (!doc) {
      throw new NotFoundException(`${LABEL} ${id} not found`);
    }
    return doc;
  }

  /** The invoice with derived overdue and its allocations (active and reversed). */
  async detail(id: string, viewer?: Viewer) {
    const doc = await this.findById(id, viewer);
    return {
      ...doc.toObject(),
      overdue: doc.status === VoucherStatus.POSTED && isOverdue(doc.dueDate, doc.balance),
      allocations: await this.allocations.forTarget(AllocationTargetType.PURCHASE_INVOICE, doc._id),
    };
  }

  async create(dto: CreatePurchaseInvoiceDto, actor: Viewer): Promise<PurchaseInvoiceDocument> {
    assertLocationAllowed(actor, dto.locationId);

    return runInTransaction(this.connection, async (session) => {
      const prepared = await this.prepare(dto, null, session);
      const voucherNo = await this.sequenceService.nextCode(SEQUENCE, session);
      const now = new Date();
      const [created] = await this.model.create(
        [{ voucherNo, ...prepared, ...unpaid(prepared.netTotal), status: VoucherStatus.POSTED, createdBy: toUserSnapshot(actor), createdAt: now }],
        { session },
      );
      await this.postLedger(created, LedgerEntryKind.POSTING, 'created', session);
      await this.stockService.post(await this.stockEntriesOf(created, session), actor, session);
      await this.record(created, AuditAction.CREATED, actor, now, session);
      await this.applyPurchasePrices(created, actor, now, session);
      return created;
    });
  }

  /** Reverses the old posting and posts the new one; the stock is checked strictly on the net result. */
  async update(id: string, dto: UpdatePurchaseInvoiceDto, actor: Viewer): Promise<PurchaseInvoiceDocument> {
    if (dto.locationId !== undefined) assertLocationAllowed(actor, dto.locationId);

    return runInTransaction(this.connection, async (session) => {
      const existing = await this.load(id, scopeOf(actor), session);
      assertNotCancelled(existing, 'edited');
      await this.allocations.assertNoActive(
        AllocationTargetType.PURCHASE_INVOICE,
        existing._id,
        `${LABEL} ${existing.voucherNo}`,
        'edited',
        session,
      );
      const date = dto.date ?? existing.voucherDate.toISOString();
      const supplierId = dto.supplierId ?? existing.supplierId.toString();
      const dateOrSupplierChanged =
        day(new Date(date)) !== day(existing.voucherDate) || supplierId !== existing.supplierId.toString();
      const next = await this.prepare(
        {
          date,
          supplierId,
          locationId: dto.locationId ?? existing.locationId.toString(),
          billNo: dto.billNo ?? existing.billNo,
          billDate: dto.billDate !== undefined ? dto.billDate : (existing.billDate?.toISOString() ?? null),
          // A new date or supplier recomputes the default due date unless one is sent.
          dueDate: dto.dueDate ?? (dateOrSupplierChanged ? undefined : existing.dueDate.toISOString()),
          remarks: dto.remarks !== undefined ? dto.remarks : existing.remarks,
          attachmentFileRefs: dto.attachmentFileRefs ?? existing.attachmentFileRefs.map((ref) => ref.toString()),
          updatePurchasePrice: dto.updatePurchasePrice ?? existing.updatePurchasePrice,
          lines: dto.lines ?? existing.lines.map(toInput),
        },
        existing._id,
        session,
      );

      const changes = await this.diff(existing, next, session);
      if (changes.length === 0) {
        throw new BadRequestException('No changes to save');
      }

      const stockReversals = await this.stockService.reversalsOf(PURCHASE_INVOICE_ENTITY_TYPE, existing._id, session);
      await this.postLedger(existing, LedgerEntryKind.REVERSAL, 'updated', session);
      const now = new Date();
      existing.set({ ...next, ...unpaid(next.netTotal), updatedBy: toUserSnapshot(actor), updatedAt: now });
      await existing.save({ session });
      await this.postLedger(existing, LedgerEntryKind.POSTING, 'updated', session);
      await this.stockService.post(
        [...stockReversals, ...(await this.stockEntriesOf(existing, session))],
        actor,
        session,
        { strict: true },
      );
      await this.record(existing, AuditAction.UPDATED, actor, now, session, { changes, reason: dto.changeNote });
      await this.applyPurchasePrices(existing, actor, now, session);
      return existing;
    });
  }

  /** Reverses ledger and stock; refused if any stock balance would go below zero. Purchase prices are left as they are. */
  async cancel(id: string, dto: CancelPurchaseInvoiceDto, actor: Viewer): Promise<PurchaseInvoiceDocument> {
    const reason = dto.reason.trim();

    return runInTransaction(this.connection, async (session) => {
      const existing = await this.load(id, scopeOf(actor), session);
      assertNotCancelled(existing, 'cancelled again');
      await this.allocations.assertNoActive(
        AllocationTargetType.PURCHASE_INVOICE,
        existing._id,
        `${LABEL} ${existing.voucherNo}`,
        'cancelled',
        session,
      );
      await this.stockService.post(
        await this.stockService.reversalsOf(PURCHASE_INVOICE_ENTITY_TYPE, existing._id, session),
        actor,
        session,
        { strict: true },
      );
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

  /** PURCHASE INVOICE as an A4 PDF: ORIGINAL then DUPLICATEs, every print audited. */
  async print(id: string, actor: Viewer): Promise<PrintedVoucher> {
    assertValidId(id);
    // Fetched before the transaction: it may call out to file storage.
    const { settings, logoDataUrl } = await this.companyService.getForPrinting();

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
      const supplier = await this.partyModel.findById(doc.supplierId).select('code name').session(session).lean().exec();
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

      const definition = buildVoucherPdf(
        {
          company: {
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
            headerAccountName: supplier ? `${supplier.code} ${supplier.name}` : doc.supplierId.toString(),
            collectedByName: locations.get(doc.locationId.toString()) ?? null,
            extraInfo: [
              { label: 'Bill No', value: doc.billNo },
              ...(doc.billDate ? [{ label: 'Bill Date', value: formatVoucherDate(doc.billDate) }] : []),
              { label: 'Due Date', value: formatVoucherDate(doc.dueDate) },
            ],
            paymentMethod: 'cash',
            paymentReference: null,
            lines: doc.lines.map((line) => ({
              counterparty: productName(line.productId),
              narration: `${line.qty} x ${line.rate}${line.discount > 0 ? ` less ${line.discount.toFixed(2)}` : ''}, VAT ${line.vatRate}%`,
              amount: line.amount,
              vat: line.vat,
              netAmount: line.netAmount,
            })),
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
        },
        {
          titles: { cash: 'PURCHASE INVOICE', bank: 'PURCHASE INVOICE' },
          documentTitle: 'Purchase Invoice',
          headerLabel: 'Supplier',
          counterpartyColumn: 'Product',
          signatures: ['Prepared by', 'Received by'],
          collectorLabel: 'Location',
        },
      );
      const buffer = await renderPdf(definition);
      await this.auditService.record(
        {
          entityType: PURCHASE_INVOICE_ENTITY_TYPE,
          entityId: doc._id,
          entityRef: doc.voucherNo,
          action: AuditAction.PRINTED,
          actor,
          changes: [{ field: 'copy', label: 'Copy', from: null, to: copyLabel(copyNumber) }],
          at: printedAt,
        },
        session,
      );
      return { buffer, filename: `${doc.voucherNo}.pdf`, copyNumber, definition };
    });
  }

  /**
   * Checks supplier, location, bill number and products, and prices the lines:
   * amount = qty x rate - discount, VAT per line, totals server-side.
   */
  private async prepare(
    input: Omit<CreatePurchaseInvoiceDto, 'remarks' | 'billDate'> & { remarks?: string | null; billDate?: string | null },
    exceptId: Types.ObjectId | null,
    session: ClientSession,
  ): Promise<Prepared> {
    const supplier = await this.partyModel.findById(asId(input.supplierId, 'supplier')).session(session).exec();
    if (!supplier || supplier.kind !== PartyKind.SUPPLIER) {
      throw new NotFoundException(`Supplier ${input.supplierId} not found`);
    }
    if (supplier.status !== PartyStatus.ACTIVE) {
      throw new BadRequestException(`Supplier ${supplier.code} (${supplier.name}) is inactive`);
    }
    await this.stockService.assertHoldsStock([], [input.locationId], session);

    const billNo = input.billNo.trim();
    const duplicate = await this.model
      .findOne({
        supplierId: supplier._id,
        billNo,
        status: { $ne: VoucherStatus.CANCELLED },
        ...(exceptId ? { _id: { $ne: exceptId } } : {}),
      })
      .collation({ locale: 'en', strength: 2 })
      .select('voucherNo')
      .session(session)
      .lean()
      .exec();
    if (duplicate) {
      throw new ConflictException(
        `Bill ${billNo} from ${supplier.code} (${supplier.name}) is already entered on ${duplicate.voucherNo}`,
      );
    }

    const products = await this.productModel
      .find({ _id: { $in: input.lines.map((line) => asId(line.productId, 'product')) } })
      .select('vatRate')
      .session(session)
      .lean()
      .exec();
    const lines = input.lines.map((line, index): PurchaseInvoiceLine => {
      const product = products.find((candidate) => candidate._id.toString() === line.productId);
      if (!product) {
        throw new NotFoundException(`Line ${index + 1}: product ${line.productId} not found`);
      }
      const qty = roundQty(line.qty);
      const discount = round2(line.discount ?? 0);
      const amount = round2(qty * line.rate - discount);
      if (!(qty > 0) || line.rate < 0 || discount < 0) {
        throw new BadRequestException(`Line ${index + 1}: quantity must be above 0, rate and discount 0 or more`);
      }
      if (amount < 0) {
        throw new BadRequestException(`Line ${index + 1}: the discount is more than the line value`);
      }
      const vatRate = line.vatRate ?? product.vatRate;
      const vat = round2((amount * vatRate) / 100);
      return {
        productId: product._id,
        qty,
        rate: line.rate,
        discount,
        amount,
        vatRate,
        vat,
        netAmount: round2(amount + vat),
      };
    });

    const voucherDate = new Date(input.date);
    const taxableTotal = sum2(lines.map((line) => line.amount));
    const totalTax = sum2(lines.map((line) => line.vat));
    return {
      voucherDate,
      supplierId: supplier._id,
      supplierAccountId: supplier.ledgerAccountId,
      locationId: new Types.ObjectId(input.locationId),
      billNo,
      billDate: input.billDate ? new Date(input.billDate) : null,
      dueDate: input.dueDate ? new Date(input.dueDate) : new Date(voucherDate.getTime() + (supplier.creditDays ?? 0) * DAY_MS),
      remarks: input.remarks?.trim() || null,
      attachmentFileRefs: (input.attachmentFileRefs ?? []).map((ref) => new Types.ObjectId(ref)),
      updatePurchasePrice: input.updatePurchasePrice ?? true,
      lines,
      grossTotal: sum2(lines.map((line) => round2(line.qty * line.rate))),
      totalDiscount: sum2(lines.map((line) => line.discount)),
      taxableTotal,
      totalTax,
      netTotal: round2(taxableTotal + totalTax),
    };
  }

  /** Dr Purchases (net before VAT), Dr VAT Input (tax), Cr supplier (net total); a reversal swaps the sides. */
  private async postLedger(doc: PurchaseInvoiceDocument, kind: LedgerEntryKind, cause: string, session: ClientSession) {
    const purchases = await this.ledgerAccountService.ensureSystemAccount(
      SYSTEM_ACCOUNTS.PURCHASES.key,
      SYSTEM_ACCOUNTS.PURCHASES.name,
      SYSTEM_ACCOUNTS.PURCHASES.type,
      session,
    );
    const vatInput = await this.ledgerAccountService.ensureSystemAccount(
      SYSTEM_ACCOUNTS.VAT_INPUT.key,
      SYSTEM_ACCOUNTS.VAT_INPUT.name,
      SYSTEM_ACCOUNTS.VAT_INPUT.type,
      session,
    );
    const narration = `${doc.voucherNo} bill ${doc.billNo}`;
    await this.posting.postEntries(
      { entityType: PURCHASE_INVOICE_ENTITY_TYPE, id: doc._id, voucherNo: doc.voucherNo, voucherDate: doc.voucherDate },
      [
        { accountId: purchases._id.toString(), debit: doc.taxableTotal, credit: 0, narration },
        { accountId: vatInput._id.toString(), debit: doc.totalTax, credit: 0, narration },
        { accountId: doc.supplierAccountId.toString(), debit: 0, credit: doc.netTotal, narration },
      ],
      kind,
      cause,
      session,
    );
  }

  /** Stock-in per stock/bundle line at the net rate (amount / qty); non-stock lines post accounts only. */
  private async stockEntriesOf(doc: PurchaseInvoiceDocument, session: ClientSession): Promise<StockEntryInput[]> {
    const stocked = await this.productModel
      .find({ _id: { $in: doc.lines.map((line) => line.productId) }, type: { $in: STOCK_PRODUCT_TYPES } })
      .select('_id')
      .session(session)
      .lean()
      .exec();
    const stockedIds = new Set(stocked.map((product) => product._id.toString()));
    return doc.lines
      .filter((line) => stockedIds.has(line.productId.toString()))
      .map((line) => ({
        productId: line.productId,
        locationId: doc.locationId,
        qty: line.qty,
        date: doc.voucherDate,
        voucherType: PURCHASE_INVOICE_ENTITY_TYPE,
        voucherId: doc._id,
        voucherNo: doc.voucherNo,
        unitCost: Math.round((line.amount / line.qty) * 10000) / 10000,
      }));
  }

  /** Sets each product's purchase price to its (last) line rate, audited on the product. */
  private async applyPurchasePrices(doc: PurchaseInvoiceDocument, actor: Viewer, at: Date, session: ClientSession) {
    if (!doc.updatePurchasePrice) return;
    const rates = new Map(doc.lines.map((line) => [line.productId.toString(), line.rate]));
    for (const [productId, rate] of rates) {
      const product = await this.productModel.findById(productId).select('code purchasePrice').session(session).exec();
      if (!product || product.purchasePrice === rate) continue;
      const from = product.purchasePrice;
      product.purchasePrice = rate;
      await product.save({ session });
      await this.auditService.record(
        {
          entityType: PRODUCT_ENTITY_TYPE,
          entityId: product._id,
          entityRef: product.code,
          action: AuditAction.UPDATED,
          actor,
          at,
          changes: [{ field: 'purchasePrice', label: 'Purchase price', from, to: rate }],
          reason: `From ${LABEL.toLowerCase()} ${doc.voucherNo}`,
        },
        session,
      );
    }
  }

  /** Field diff for the audit: header fields by display value, and each product's line. */
  private async diff(before: PurchaseInvoiceDocument, after: Prepared, session: ClientSession): Promise<AuditChange[]> {
    const parties = await this.namesOf(this.partyModel, [before.supplierId, after.supplierId], session);
    const locations = await this.namesOf(this.locationModel, [before.locationId, after.locationId], session);
    const header = (doc: Prepared | PurchaseInvoiceDocument) => ({
      date: day(doc.voucherDate),
      supplier: parties.get(doc.supplierId.toString()) ?? doc.supplierId.toString(),
      location: locations.get(doc.locationId.toString()) ?? doc.locationId.toString(),
      billNo: doc.billNo,
      billDate: doc.billDate ? day(doc.billDate) : null,
      dueDate: day(doc.dueDate),
      remarks: doc.remarks,
      attachments: doc.attachmentFileRefs.map((ref) => ref.toString()).join(', '),
      updatePurchasePrice: doc.updatePurchasePrice,
      netTotal: doc.netTotal,
    });
    const changes = diffFields(header(before), header(after), [
      { key: 'date', label: 'Date' },
      { key: 'supplier', label: 'Supplier' },
      { key: 'location', label: 'Location' },
      { key: 'billNo', label: 'Bill No' },
      { key: 'billDate', label: 'Bill Date' },
      { key: 'dueDate', label: 'Due Date' },
      { key: 'remarks', label: 'Remarks' },
      { key: 'attachments', label: 'Attachments' },
      { key: 'updatePurchasePrice', label: 'Update purchase price' },
      { key: 'netTotal', label: 'Net total' },
    ]);

    const describe = (lines: readonly PurchaseInvoiceLine[]) => {
      const byProduct = new Map<string, string[]>();
      for (const line of lines) {
        const text = `${line.qty} @ ${line.rate}${line.discount > 0 ? ` - ${line.discount.toFixed(2)}` : ''}, VAT ${line.vatRate}%`;
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
    doc: PurchaseInvoiceDocument,
    action: AuditAction,
    actor: Viewer,
    at: Date,
    session: ClientSession,
    extra: { changes?: AuditChange[]; reason?: string } = {},
  ) {
    return this.auditService.record(
      { entityType: PURCHASE_INVOICE_ENTITY_TYPE, entityId: doc._id, entityRef: doc.voucherNo, action, actor, at, ...extra },
      session,
    );
  }
}

/** "own"-scoped users: only invoices at their allowed locations. */
function scopeOf(user: Viewer | undefined): Record<string, unknown> | null {
  const allowed = stockLocationScope(user);
  return allowed ? { locationId: { $in: allowed.map((id) => new Types.ObjectId(id)) } } : null;
}

function assertLocationAllowed(user: Viewer, locationId: string): void {
  const allowed = stockLocationScope(user);
  if (allowed && !allowed.includes(locationId)) {
    throw new ForbiddenException('You may not enter purchases at this location');
  }
}

/** Payment fields of an invoice with nothing allocated (edit and cancel are blocked while anything is). */
function unpaid(netTotal: number) {
  return { paidAmount: 0, balance: netTotal, paymentStatus: paymentStatusOf(netTotal, 0) };
}

function toInput(line: PurchaseInvoiceLine): PurchaseInvoiceLineDto {
  return {
    productId: line.productId.toString(),
    qty: line.qty,
    rate: line.rate,
    discount: line.discount,
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

function assertNotCancelled(doc: PurchaseInvoiceDocument, action: string): void {
  if (doc.status === VoucherStatus.CANCELLED) {
    throw new BadRequestException(`${LABEL} ${doc.voucherNo} is cancelled and cannot be ${action}`);
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
