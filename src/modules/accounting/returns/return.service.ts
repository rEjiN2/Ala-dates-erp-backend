import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import { type ReturnDefinition } from './return-definition.js';
import { type ReturnDocument, type ReturnLine } from './schemas/return.schema.js';
import type { ReturnQueryDto } from './dto/return.dto.js';
import { STOCK_PRODUCT_TYPES, StockService, roundQty, stockLocationScope, type StockEntryInput } from '../../stock/stock.service.js';
import { Product, ProductDocument } from '../../product/products/schemas/product.schema.js';
import { Party, PartyDocument } from '../../party/schemas/party.schema.js';
import { Location, LocationDocument } from '../../location/schemas/location.schema.js';
import { PurchaseInvoice, PURCHASE_INVOICE_ENTITY_TYPE } from '../../purchase/purchase-invoices/schemas/purchase-invoice.schema.js';
import { SalesInvoice, SALES_INVOICE_ENTITY_TYPE } from '../../sales/sales-invoices/schemas/sales-invoice.schema.js';
import { VoucherStatus, type VoucherDocument } from '../vouchers/schemas/voucher.schema.js';
import { LedgerEntryKind } from '../vouchers/schemas/ledger-entry.schema.js';
import { VoucherPostingService } from '../vouchers/voucher-posting.service.js';
import { buildVoucherPdf, copyLabel, formatMoney } from '../vouchers/voucher-pdf.js';
import type { PrintedVoucher } from '../vouchers/voucher-print.service.js';
import { withScope } from '../vouchers/data-scope.js';
import { LedgerAccountService } from '../ledger-accounts/ledger-account.service.js';
import { AllocationService } from '../allocations/allocation.service.js';
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

type Viewer = AuthenticatedUser;
export type ReturnModel = Model<ReturnDocument>;

export interface ReturnInput {
  date: string;
  invoiceId: string;
  locationId?: string;
  reason: string;
  lines: { invoiceLineId: string; qty: number; restock?: boolean }[];
}

export interface ReturnUpdateInput {
  date?: string;
  locationId?: string;
  reason?: string;
  lines?: ReturnInput['lines'];
  changeNote?: string;
}

/** The parts of a sales or purchase invoice a return reads and moves. */
interface InvoiceLine {
  _id?: Types.ObjectId;
  productId: Types.ObjectId;
  qty: number;
  rate: number;
  discount: number;
  amount: number;
  vatRate: number;
  vat: number;
  netAmount: number;
  unitCost?: number;
  returnedQty?: number;
}

interface InvoiceDoc {
  _id: Types.ObjectId;
  voucherNo: string;
  status: VoucherStatus;
  locationId: Types.ObjectId;
  balance: number;
  returnedQty?: number;
  returnedAmount?: number;
  lines: InvoiceLine[];
  get(path: string): unknown;
  save(options: { session: ClientSession }): Promise<unknown>;
}

/** Everything a save writes onto the return, checked and priced. */
interface Prepared {
  voucherDate: Date;
  invoiceId: Types.ObjectId;
  invoiceNo: string;
  partyId: Types.ObjectId;
  partyAccountId: Types.ObjectId;
  locationId: Types.ObjectId;
  soldById: Types.ObjectId | null;
  reason: string;
  lines: ReturnLine[];
  taxableTotal: number;
  totalTax: number;
  netTotal: number;
}

/**
 * Sales and purchase returns (credit and debit notes) against an invoice. One
 * transaction per save: number, ledger entries, stock, the invoice's returned
 * quantities, the auto-allocation of the credit to that invoice (up to its
 * balance; the rest stays on account) and audit. Edit = reverse + repost,
 * and edit/cancel are refused once the credit was applied anywhere else.
 */
@Injectable()
export class ReturnService {
  private readonly invoiceModels: Record<string, Model<unknown>>;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(SalesInvoice.name) salesInvoiceModel: Model<unknown>,
    @InjectModel(PurchaseInvoice.name) purchaseInvoiceModel: Model<unknown>,
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
    private readonly entityAccess: EntityAccessRegistry,
  ) {
    this.invoiceModels = {
      [SALES_INVOICE_ENTITY_TYPE]: salesInvoiceModel,
      [PURCHASE_INVOICE_ENTITY_TYPE]: purchaseInvoiceModel,
    };
  }

  /** Hooks a return type into allocations (its credit is a "payment line"), comments and activity. Call once, from its service. */
  registerReturnType(def: ReturnDefinition, model: ReturnModel): void {
    this.allocations.registerPaymentSource(def.entityType, model as unknown as Model<VoucherDocument>, def.partyKind, {
      accountField: 'partyAccountId',
      linesOf: (voucher) => {
        const note = voucher as unknown as { partyAccountId: Types.ObjectId; netTotal: number };
        return [{ accountId: note.partyAccountId, netAmount: note.netTotal }];
      },
    });
    this.entityAccess.register(def.entityType, {
      exists: async (id, user) => Boolean(await model.exists(withScope({ _id: id }, def.scope(user))).exec()),
      canRead: (user) => hasPermission(user, def.readPermission),
    });
  }

  async findAll(def: ReturnDefinition, model: ReturnModel, query: ReturnQueryDto = {}, viewer?: Viewer) {
    const filter: Record<string, unknown> = {};
    if (query.dateFrom || query.dateTo) {
      const range: { $gte?: Date; $lte?: Date } = {};
      if (query.dateFrom) range.$gte = new Date(query.dateFrom);
      if (query.dateTo) range.$lte = endOfDayIfDateOnly(query.dateTo);
      filter.voucherDate = range;
    }
    if (query.status === 'posted') filter.status = VoucherStatus.POSTED;
    else if (query.status === 'cancelled') filter.status = VoucherStatus.CANCELLED;
    if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
    if (query.invoiceId) filter.invoiceId = new Types.ObjectId(query.invoiceId);
    const term = query.q?.trim();
    if (term) {
      const pattern = new RegExp(escapeRegExp(term), 'i');
      filter.$or = [{ voucherNo: pattern }, { invoiceNo: pattern }];
    }
    const scoped = withScope(filter, def.scope(viewer));
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const [docs, summaryRows] = await Promise.all([
      model
        .find(scoped)
        .sort({ voucherDate: -1, voucherNo: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean()
        .exec(),
      model
        .aggregate<{ count: number; netTotal: number }>([
          { $match: scoped },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              // A cancelled return credits nothing.
              netTotal: { $sum: { $cond: [{ $eq: ['$status', VoucherStatus.CANCELLED] }, 0, '$netTotal'] } },
            },
          },
        ])
        .exec(),
    ]);
    const [comments, locations, parties] = await Promise.all([
      this.commentsService.countByEntityIds(
        def.entityType,
        docs.map((doc) => doc._id),
      ),
      this.namesOf(this.locationModel, docs.map((doc) => doc.locationId)),
      this.namesOf(this.partyModel, docs.map((doc) => doc.partyId)),
    ]);
    return {
      items: docs.map((doc) => ({
        id: doc._id.toString(),
        voucherNo: doc.voucherNo,
        voucherDate: doc.voucherDate,
        invoice: { id: doc.invoiceId.toString(), voucherNo: doc.invoiceNo },
        party: { id: doc.partyId.toString(), name: parties.get(doc.partyId.toString()) ?? null },
        location: { id: doc.locationId.toString(), name: locations.get(doc.locationId.toString()) ?? null },
        reason: doc.reason,
        lineCount: doc.lines.length,
        taxableTotal: doc.taxableTotal,
        totalTax: doc.totalTax,
        netTotal: doc.netTotal,
        status: doc.status,
        createdBy: userRefOf(doc.createdBy as UserSnapshot | null),
        createdAt: doc.createdAt ?? null,
        updatedBy: userRefOf(doc.updatedBy as UserSnapshot | null),
        updatedAt: doc.updatedAt ?? null,
        commentCount: comments.get(doc._id.toString()) ?? 0,
      })),
      page,
      pageSize,
      summary: { count: summaryRows[0]?.count ?? 0, netTotal: round2(summaryRows[0]?.netTotal ?? 0) },
    };
  }

  async findById(def: ReturnDefinition, model: ReturnModel, id: string, viewer?: Viewer): Promise<ReturnDocument> {
    assertValidId(def, id);
    const doc = await model.findOne(withScope({ _id: new Types.ObjectId(id) }, def.scope(viewer))).exec();
    if (!doc) {
      throw new NotFoundException(`${def.label} ${id} not found`);
    }
    return doc;
  }

  /** The return with its credit allocations and what is still on account. */
  async detail(def: ReturnDefinition, model: ReturnModel, id: string, viewer: Viewer) {
    const doc = await this.findById(def, model, id, viewer);
    const allocations = await this.allocations.forPayment(def.entityType, doc._id);
    const applied = sum2(allocations.map((allocation) => allocation.amount));
    return {
      ...this.view(def, doc, viewer),
      allocations,
      creditApplied: applied,
      onAccount: doc.status === VoucherStatus.CANCELLED ? 0 : round2(doc.netTotal - applied),
    };
  }

  /** The return as returned by the API: the cost snapshot only with products:view-cost where it is sensitive. */
  view(def: ReturnDefinition, doc: ReturnDocument, viewer: Viewer) {
    const plain = doc.toObject();
    if (!def.hidesCost || hasPermission(viewer, Permission.PRODUCTS_VIEW_COST)) return plain;
    return { ...plain, lines: plain.lines.map(({ unitCost: _unitCost, ...line }) => line) };
  }

  async create(def: ReturnDefinition, model: ReturnModel, input: ReturnInput, actor: Viewer): Promise<ReturnDocument> {
    return runInTransaction(this.connection, async (session) => {
      const invoice = await this.loadInvoice(def, input.invoiceId, def.scope(actor), session);
      assertInvoiceOpen(def, invoice);
      const locationId = input.locationId ?? invoice.locationId.toString();
      assertLocationAllowed(actor, locationId);
      const prepared = await this.prepare(def, { ...input, locationId }, invoice, session);

      const voucherNo = await this.sequenceService.nextCode(def.sequence, session);
      const now = new Date();
      const [created] = await model.create(
        [
          {
            voucherNo,
            ...prepared,
            autoAllocationId: null,
            status: VoucherStatus.POSTED,
            createdBy: toUserSnapshot(actor),
            createdAt: now,
          },
        ],
        { session },
      );
      applyReturned(invoice, prepared.lines, prepared.netTotal, 1);
      await invoice.save({ session });
      await this.postLedger(def, created, LedgerEntryKind.POSTING, 'created', session);
      await this.stockService.post(await this.stockEntriesOf(def, created, session), actor, session, {
        strict: def.stockDirection === 'in',
      });
      await this.autoAllocate(def, created, actor, session);
      await this.record(def, created, AuditAction.CREATED, actor, now, session);
      return created;
    });
  }

  /**
   * Reverses the old posting (and its auto-allocation) and posts the new one.
   * Refused once the credit was applied anywhere but the auto-allocation.
   */
  async update(
    def: ReturnDefinition,
    model: ReturnModel,
    id: string,
    input: ReturnUpdateInput,
    actor: Viewer,
  ): Promise<ReturnDocument> {
    if (input.locationId !== undefined) assertLocationAllowed(actor, input.locationId);

    return runInTransaction(this.connection, async (session) => {
      const existing = await this.load(def, model, id, def.scope(actor), session);
      assertNotCancelled(def, existing, 'edited');
      await this.assertOnlyAutoAllocation(def, existing, 'edited', session);
      // First, so the invoice read next already has its balance back.
      await this.allocations.reverseForPayment(
        def.entityType,
        existing._id,
        `${def.label} ${existing.voucherNo} edited`,
        actor,
        session,
      );
      const invoice = await this.loadInvoice(def, existing.invoiceId.toString(), null, session);
      // Take this return's own quantities out first: what it may return is what the others left.
      applyReturned(invoice, existing.lines, existing.netTotal, -1);
      const prepared = await this.prepare(
        def,
        {
          date: input.date ?? existing.voucherDate.toISOString(),
          invoiceId: existing.invoiceId.toString(),
          locationId: input.locationId ?? existing.locationId.toString(),
          reason: input.reason ?? existing.reason,
          lines: input.lines ?? [],
        },
        invoice,
        session,
        // Lines not sent keep the amounts they were saved with.
        input.lines ? undefined : existing.lines.map(toPlainLine),
      );

      const changes = await this.diff(existing, prepared, session);
      if (changes.length === 0) {
        throw new BadRequestException('No changes to save');
      }
      applyReturned(invoice, prepared.lines, prepared.netTotal, 1);
      await invoice.save({ session });

      const stockReversals = await this.stockService.reversalsOf(def.entityType, existing._id, session);
      await this.postLedger(def, existing, LedgerEntryKind.REVERSAL, 'updated', session);
      const now = new Date();
      existing.set({ ...prepared, autoAllocationId: null, updatedBy: toUserSnapshot(actor), updatedAt: now });
      await existing.save({ session });
      await this.postLedger(def, existing, LedgerEntryKind.POSTING, 'updated', session);
      await this.stockService.post([...stockReversals, ...(await this.stockEntriesOf(def, existing, session))], actor, session, {
        strict: def.stockDirection === 'in',
      });
      await this.autoAllocate(def, existing, actor, session);
      await this.record(def, existing, AuditAction.UPDATED, actor, now, session, { changes, reason: input.changeNote });
      return existing;
    });
  }

  /**
   * Gives the credit back (the invoice owes it again), reverses ledger and
   * stock, and releases the returned quantities. A sales return whose stock
   * was since used is refused (that stock would go below zero).
   */
  async cancel(
    def: ReturnDefinition,
    model: ReturnModel,
    id: string,
    reasonText: string,
    actor: Viewer,
  ): Promise<ReturnDocument> {
    const reason = reasonText.trim();

    return runInTransaction(this.connection, async (session) => {
      const existing = await this.load(def, model, id, def.scope(actor), session);
      assertNotCancelled(def, existing, 'cancelled again');
      await this.assertOnlyAutoAllocation(def, existing, 'cancelled', session);
      await this.allocations.reverseForPayment(
        def.entityType,
        existing._id,
        `${def.label} ${existing.voucherNo} cancelled`,
        actor,
        session,
      );
      await this.stockService.post(await this.stockService.reversalsOf(def.entityType, existing._id, session), actor, session, {
        strict: def.stockDirection === 'in',
      });
      await this.postLedger(def, existing, LedgerEntryKind.REVERSAL, 'cancelled', session);
      const invoice = await this.loadInvoice(def, existing.invoiceId.toString(), null, session);
      applyReturned(invoice, existing.lines, existing.netTotal, -1);
      await invoice.save({ session });

      const now = new Date();
      existing.status = VoucherStatus.CANCELLED;
      existing.cancelledBy = toUserSnapshot(actor);
      existing.cancelledAt = now;
      existing.cancelReason = reason;
      await existing.save({ session });
      await this.record(def, existing, AuditAction.CANCELLED, actor, now, session, {
        changes: [{ field: 'status', label: 'Status', from: VoucherStatus.POSTED, to: VoucherStatus.CANCELLED }],
        reason,
      });
      return existing;
    });
  }

  /** CREDIT NOTE / DEBIT NOTE as an A4 PDF: ORIGINAL then DUPLICATEs, every print audited. */
  async print(def: ReturnDefinition, model: ReturnModel, id: string, actor: Viewer): Promise<PrintedVoucher> {
    assertValidId(def, id);
    // Fetched before the transaction: it may call out to file storage.
    const { settings, logoDataUrl } = await this.companyService.getForPrinting();

    return runInTransaction(this.connection, async (session) => {
      const doc = await model
        .findOneAndUpdate(
          withScope({ _id: new Types.ObjectId(id) }, def.scope(actor)),
          { $inc: { printCount: 1 } },
          { returnDocument: 'after', session },
        )
        .exec();
      if (!doc) {
        throw new NotFoundException(`${def.label} ${id} not found`);
      }
      const party = await this.partyModel.findById(doc.partyId).select('code name vatNumber').session(session).lean().exec();
      const invoice = await this.invoiceModels[def.invoiceEntityType]
        .findById(doc.invoiceId)
        .select('voucherNo billNo')
        .session(session)
        .lean<{ voucherNo: string; billNo?: string }>()
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
      const vatSummary = new Map<number, { taxable: number; vat: number }>();
      for (const line of doc.lines) {
        const row = vatSummary.get(line.vatRate) ?? { taxable: 0, vat: 0 };
        vatSummary.set(line.vatRate, { taxable: round2(row.taxable + line.amount), vat: round2(row.vat + line.vat) });
      }
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
            headerAccountName: party ? `${party.code} ${party.name}` : doc.partyId.toString(),
            collectedByName: locations.get(doc.locationId.toString()) ?? null,
            extraInfo: [
              { label: `Original ${def.invoiceLabel.toLowerCase()}`, value: doc.invoiceNo },
              ...(invoice?.billNo ? [{ label: 'Supplier Bill No', value: invoice.billNo }] : []),
              { label: def.pdf.partyTrnLabel, value: party?.vatNumber ?? '-' },
              { label: 'Reason', value: doc.reason },
              ...[...vatSummary].map(([rate, row]) => ({
                label: `VAT ${rate}%`,
                value: `${formatMoney(row.vat)} on ${formatMoney(row.taxable)}`,
              })),
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
            comments: doc.reason,
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
          titles: { cash: def.pdf.title, bank: def.pdf.title },
          documentTitle: def.pdf.documentTitle,
          headerLabel: def.pdf.partyLabel,
          counterpartyColumn: 'Product',
          signatures: def.pdf.signatures,
          collectorLabel: 'Location',
        },
      );
      const buffer = await renderPdf(definition);
      await this.auditService.record(
        {
          entityType: def.entityType,
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
   * Checks the location and the requested lines against the invoice and
   * prices them: rate, discount and VAT are the invoice line's, pro-rata (a
   * return completing a line gets exactly what is left of it).
   */
  private async prepare(
    def: ReturnDefinition,
    input: { date: string; invoiceId: string; locationId: string; reason: string; lines: ReturnInput['lines'] },
    invoice: InvoiceDoc,
    session: ClientSession,
    keep?: ReturnLine[],
  ): Promise<Prepared> {
    await this.stockService.assertHoldsStock([], [input.locationId], session);
    const lines = keep ?? (await this.priceLines(def, input.lines, invoice, session));
    const taxableTotal = sum2(lines.map((line) => line.amount));
    const totalTax = sum2(lines.map((line) => line.vat));
    return {
      voucherDate: new Date(input.date),
      invoiceId: invoice._id,
      invoiceNo: invoice.voucherNo,
      partyId: invoice.get(def.invoicePartyField) as Types.ObjectId,
      partyAccountId: invoice.get(def.invoicePartyAccountField) as Types.ObjectId,
      locationId: new Types.ObjectId(input.locationId),
      soldById: (invoice.get('soldById') as Types.ObjectId | undefined) ?? null,
      reason: input.reason.trim(),
      lines,
      taxableTotal,
      totalTax,
      netTotal: round2(taxableTotal + totalTax),
    };
  }

  private async priceLines(
    def: ReturnDefinition,
    requested: ReturnInput['lines'],
    invoice: InvoiceDoc,
    session: ClientSession,
  ): Promise<ReturnLine[]> {
    const products = await this.productModel
      .find({ _id: { $in: invoice.lines.map((line) => line.productId) } })
      .select('code name')
      .session(session)
      .lean()
      .exec();
    const seen = new Set<string>();
    return requested.map((request, index): ReturnLine => {
      const row = index + 1;
      if (!Types.ObjectId.isValid(request.invoiceLineId)) {
        throw new BadRequestException(`Line ${row}: invoice line id "${request.invoiceLineId}" is not a valid id`);
      }
      if (seen.has(request.invoiceLineId)) {
        throw new BadRequestException(`Line ${row}: that invoice line is already on this ${def.label.toLowerCase()}`);
      }
      seen.add(request.invoiceLineId);
      const source = invoice.lines.find((line) => line._id?.toString() === request.invoiceLineId);
      if (!source) {
        throw new NotFoundException(`Line ${row}: ${invoice.voucherNo} has no line ${request.invoiceLineId}`);
      }
      const product = products.find((candidate) => candidate._id.equals(source.productId));
      const name = product ? `${product.code} (${product.name})` : source.productId.toString();
      const qty = roundQty(request.qty);
      if (!(qty > 0)) {
        throw new BadRequestException(`Line ${row}: quantity must be above 0`);
      }
      const returned = source.returnedQty ?? 0;
      const available = roundQty(source.qty - returned);
      if (qty > available) {
        throw new BadRequestException(
          `Line ${row}: ${name} has ${available} left to return (${source.qty} on ${invoice.voucherNo}, ${returned} already returned), not ${qty}`,
        );
      }
      // Cumulative rounding: the shares of successive returns add up to exactly the line.
      const after = roundQty(returned + qty);
      const share = (total: number) => round2(round2((total * after) / source.qty) - round2((total * returned) / source.qty));
      const amount = share(source.amount);
      const vat = share(source.vat);
      return {
        invoiceLineId: source._id!,
        productId: source.productId,
        qty,
        restock: def.stockDirection === 'in' ? (request.restock ?? true) : true,
        rate: source.rate,
        discount: share(source.discount),
        amount,
        vatRate: source.vatRate,
        vat,
        netAmount: round2(amount + vat),
        unitCost: source.unitCost ?? Math.round((source.amount / source.qty) * 10000) / 10000,
      };
    });
  }

  /** Applies the credit to the original invoice, up to its balance; the rest stays on account. */
  private async autoAllocate(def: ReturnDefinition, doc: ReturnDocument, actor: Viewer, session: ClientSession) {
    const invoice = await this.loadInvoice(def, doc.invoiceId.toString(), null, session);
    const amount = round2(Math.min(doc.netTotal, invoice.balance));
    if (!(amount > 0)) return;
    const allocation = await this.allocations.allocateLine(
      def.entityType,
      doc._id,
      { lineIndex: 0, targetType: def.targetType, targetId: doc.invoiceId.toString(), amount },
      actor,
      session,
    );
    doc.autoAllocationId = allocation._id;
    await doc.save({ session });
  }

  /** The credit may be edited or cancelled only while nothing but the auto-allocation is applied. */
  private async assertOnlyAutoAllocation(def: ReturnDefinition, doc: ReturnDocument, action: string, session: ClientSession) {
    const active = await this.allocations.activeForPayment(def.entityType, doc._id, session);
    const manual = active.filter((allocation) => allocation.id !== doc.autoAllocationId?.toString());
    if (manual.length > 0) {
      throw new ConflictException(
        `${def.label} ${doc.voucherNo} has its credit applied to ${[...new Set(manual.map((a) => a.targetNo))].join(', ')}; reverse that allocation before it can be ${action}`,
      );
    }
  }

  /** Sales: Dr Sales Returns (net), Dr VAT Output (tax), Cr customer. Purchase: Dr supplier, Cr Purchase Returns, Cr VAT Input. A reversal swaps the sides. */
  private async postLedger(def: ReturnDefinition, doc: ReturnDocument, kind: LedgerEntryKind, cause: string, session: ClientSession) {
    const contra = await this.ledgerAccountService.ensureSystemAccount(
      def.contraAccount.key,
      def.contraAccount.name,
      def.contraAccount.type,
      session,
    );
    const vat = await this.ledgerAccountService.ensureSystemAccount(
      def.vatAccount.key,
      def.vatAccount.name,
      def.vatAccount.type,
      session,
    );
    const narration = `${doc.voucherNo} against ${doc.invoiceNo}`;
    const party = def.partyCredited ? { debit: 0, credit: doc.netTotal } : { debit: doc.netTotal, credit: 0 };
    const other = (amount: number) => (def.partyCredited ? { debit: amount, credit: 0 } : { debit: 0, credit: amount });
    await this.posting.postEntries(
      { entityType: def.entityType, id: doc._id, voucherNo: doc.voucherNo, voucherDate: doc.voucherDate },
      [
        { accountId: doc.partyAccountId.toString(), ...party, narration },
        { accountId: contra._id.toString(), ...other(doc.taxableTotal), narration },
        { accountId: vat._id.toString(), ...other(doc.totalTax), narration },
      ],
      kind,
      cause,
      session,
    );
  }

  /** Stock per stock/bundle line at the location: restocked lines in (sales), every line out (purchase). */
  private async stockEntriesOf(def: ReturnDefinition, doc: ReturnDocument, session: ClientSession): Promise<StockEntryInput[]> {
    const stocked = await this.productModel
      .find({ _id: { $in: doc.lines.map((line) => line.productId) }, type: { $in: STOCK_PRODUCT_TYPES } })
      .select('_id')
      .session(session)
      .lean()
      .exec();
    const stockedIds = new Set(stocked.map((product) => product._id.toString()));
    const into = def.stockDirection === 'in';
    return doc.lines
      .filter((line) => stockedIds.has(line.productId.toString()) && (!into || line.restock))
      .map((line) => ({
        productId: line.productId,
        locationId: doc.locationId,
        qty: into ? line.qty : -line.qty,
        date: doc.voucherDate,
        voucherType: def.entityType,
        voucherId: doc._id,
        voucherNo: doc.voucherNo,
        unitCost: line.unitCost,
      }));
  }

  /** Field diff for the audit: header fields by display value, and each product's line. */
  private async diff(before: ReturnDocument, after: Prepared, session: ClientSession): Promise<AuditChange[]> {
    const locations = await this.namesOf(this.locationModel, [before.locationId, after.locationId], session);
    const header = (doc: Prepared | ReturnDocument) => ({
      date: day(doc.voucherDate),
      location: locations.get(doc.locationId.toString()) ?? doc.locationId.toString(),
      reason: doc.reason,
      netTotal: doc.netTotal,
    });
    const changes = diffFields(header(before), header(after), [
      { key: 'date', label: 'Date' },
      { key: 'location', label: 'Location' },
      { key: 'reason', label: 'Reason' },
      { key: 'netTotal', label: 'Net total' },
    ]);

    const describe = (lines: readonly ReturnLine[]) =>
      new Map(lines.map((line) => [line.productId.toString(), `${line.qty}${line.restock ? '' : ' (no restock)'}`]));
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

  private async loadInvoice(
    def: ReturnDefinition,
    id: string,
    scope: Record<string, unknown> | null,
    session: ClientSession,
  ): Promise<InvoiceDoc> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`${def.invoiceLabel} id "${id}" is not a valid id`);
    }
    const invoice = await this.invoiceModels[def.invoiceEntityType]
      .findOne(withScope({ _id: new Types.ObjectId(id) }, scope))
      .session(session)
      .exec();
    if (!invoice) {
      throw new NotFoundException(`${def.invoiceLabel} ${id} not found`);
    }
    return invoice as unknown as InvoiceDoc;
  }

  private async load(
    def: ReturnDefinition,
    model: ReturnModel,
    id: string,
    scope: Record<string, unknown> | null,
    session: ClientSession,
  ) {
    assertValidId(def, id);
    const doc = await model
      .findOne(withScope({ _id: new Types.ObjectId(id) }, scope))
      .session(session)
      .exec();
    if (!doc) {
      throw new NotFoundException(`${def.label} ${id} not found`);
    }
    return doc;
  }

  private record(
    def: ReturnDefinition,
    doc: ReturnDocument,
    action: AuditAction,
    actor: Viewer,
    at: Date,
    session: ClientSession,
    extra: { changes?: AuditChange[]; reason?: string } = {},
  ) {
    return this.auditService.record(
      { entityType: def.entityType, entityId: doc._id, entityRef: doc.voucherNo, action, actor, at, ...extra },
      session,
    );
  }
}

/** Adds (+1) or releases (-1) a return's quantities and amount on its invoice; the caller saves the invoice. */
function applyReturned(invoice: InvoiceDoc, lines: readonly ReturnLine[], netTotal: number, sign: 1 | -1): void {
  for (const line of lines) {
    const source = invoice.lines.find((candidate) => candidate._id?.toString() === line.invoiceLineId.toString());
    if (source) source.returnedQty = Math.max(0, roundQty((source.returnedQty ?? 0) + sign * line.qty));
  }
  invoice.returnedQty = roundQty(invoice.lines.reduce((sum, line) => sum + (line.returnedQty ?? 0), 0));
  invoice.returnedAmount = Math.max(0, round2((invoice.returnedAmount ?? 0) + sign * netTotal));
}

/** A saved line as a plain object, for keeping it through an edit that sends no lines. */
function toPlainLine(line: ReturnLine): ReturnLine {
  return {
    invoiceLineId: line.invoiceLineId,
    productId: line.productId,
    qty: line.qty,
    restock: line.restock,
    rate: line.rate,
    discount: line.discount,
    amount: line.amount,
    vatRate: line.vatRate,
    vat: line.vat,
    netAmount: line.netAmount,
    unitCost: line.unitCost,
  };
}

/** Only a scoped user's own locations may take stock. */
function assertLocationAllowed(user: Viewer, locationId: string): void {
  const allowed = stockLocationScope(user);
  if (allowed && !allowed.includes(locationId)) {
    throw new ForbiddenException('You may not return stock at this location');
  }
}

function assertInvoiceOpen(def: ReturnDefinition, invoice: InvoiceDoc): void {
  if (invoice.status === VoucherStatus.CANCELLED) {
    throw new BadRequestException(`${def.invoiceLabel} ${invoice.voucherNo} is cancelled and can't be returned against`);
  }
}

function assertNotCancelled(def: ReturnDefinition, doc: ReturnDocument, action: string): void {
  if (doc.status === VoucherStatus.CANCELLED) {
    throw new BadRequestException(`${def.label} ${doc.voucherNo} is cancelled and cannot be ${action}`);
  }
}

function assertValidId(def: ReturnDefinition, id: string): void {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestException(`${def.label} id "${id}" is not a valid id`);
  }
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A date-only filter bound covers the whole day. */
function endOfDayIfDateOnly(value: string): Date {
  const date = new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
}
