import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import {
  ALLOCATION_ENTITY_TYPE,
  Allocation,
  AllocationDocument,
  AllocationStatus,
  AllocationTargetType,
  isOverdue,
  paymentStatusOf,
} from './schemas/allocation.schema.js';
import type { CreateAllocationDto } from './dto/allocation.dto.js';
import {
  PURCHASE_INVOICE_ENTITY_TYPE,
  PurchaseInvoice,
  PurchaseInvoiceDocument,
} from '../../purchase/purchase-invoices/schemas/purchase-invoice.schema.js';
import {
  SALES_INVOICE_ENTITY_TYPE,
  SalesInvoice,
  SalesInvoiceDocument,
} from '../../sales/sales-invoices/schemas/sales-invoice.schema.js';
import { OpeningBalance, OpeningBalanceDocument } from '../opening-balances/schemas/opening-balance.schema.js';
import { CREDIT_NOTE_TYPES } from '../returns/schemas/return.schema.js';
import { VoucherStatus, type VoucherDocument } from '../vouchers/schemas/voucher.schema.js';
import { Party, PartyDocument, PartyKind } from '../../party/schemas/party.schema.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction } from '../../audit/schemas/audit-log.schema.js';
import { type Actor, toUserSnapshot, userRefOf } from '../../../common/schemas/user-snapshot.schema.js';
import { round2, sum2 } from '../../../common/utils/money.util.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';

/** A payment line's allocation request, by line position. */
export interface LineAllocation {
  lineIndex: number;
  targetType: AllocationTargetType;
  targetId: string;
  amount: number;
}

type InvoiceDocument = PurchaseInvoiceDocument | SalesInvoiceDocument;

interface Target {
  no: string;
  partyId: Types.ObjectId;
  balance: number;
  invoice: InvoiceDocument | null;
}

/**
 * A credit note (sales or purchase return) as a payment source: it has no
 * cash-voucher lines, so it names where the party's account sits and its one
 * "line" (the party's side of the note).
 */
export interface CreditSource {
  /** Mongo path of the party's ledger account on the document. */
  accountField: string;
  linesOf: (voucher: VoucherDocument) => { accountId: Types.ObjectId; netAmount: number }[];
}

/** A payment voucher type and the side it settles: payments pay suppliers' bills, receipts settle customers'. */
interface PaymentSource {
  model: Model<VoucherDocument>;
  partyKind: PartyKind;
  credit?: CreditSource;
}

const linesOf = (source: PaymentSource, voucher: VoucherDocument) =>
  source.credit ? source.credit.linesOf(voucher) : voucher.lines;

const TOLERANCE = 0.001;

/**
 * Applies payment lines to bills (purchase invoices, a party's opening
 * balance). Payment vouchers register themselves as sources, so the same
 * engine serves sales receipts later. Every change runs in the caller's
 * transaction (or its own) with an audit entry; invoices keep paidAmount,
 * balance and paymentStatus in step.
 */
@Injectable()
export class AllocationService {
  private readonly sources = new Map<string, PaymentSource>();

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Allocation.name)
    private readonly model: Model<AllocationDocument>,
    @InjectModel(PurchaseInvoice.name)
    private readonly invoiceModel: Model<PurchaseInvoiceDocument>,
    @InjectModel(SalesInvoice.name)
    private readonly salesInvoiceModel: Model<SalesInvoiceDocument>,
    @InjectModel(OpeningBalance.name)
    private readonly openingModel: Model<OpeningBalanceDocument>,
    @InjectModel(Party.name) private readonly partyModel: Model<PartyDocument>,
    private readonly auditService: AuditService,
  ) {}

  /** Called once by each payment voucher service, e.g. ("cash-payment", its model, supplier). Returns pass `credit`. */
  registerPaymentSource(
    paymentVoucherType: string,
    model: Model<VoucherDocument>,
    partyKind: PartyKind,
    credit?: CreditSource,
  ): void {
    this.sources.set(paymentVoucherType, { model, partyKind, credit });
  }

  /** The party's bills with money still owed, oldest due first. */
  async openBills(partyId: string) {
    const party = await this.party(partyId);
    const paidOn = await this.activeByKey(party._id, (a) => `${a.targetType}:${a.targetId.toString()}`);
    const bills = [];
    if (party.kind === PartyKind.SUPPLIER) {
      const invoices = await this.invoiceModel
        .find({
          supplierId: party._id,
          status: VoucherStatus.POSTED,
          balance: { $gt: 0 },
        })
        .lean()
        .exec();
      bills.push(
        ...invoices.map((invoice) => ({
          type: AllocationTargetType.PURCHASE_INVOICE,
          id: invoice._id.toString(),
          number: invoice.voucherNo,
          billNo: invoice.billNo,
          date: invoice.voucherDate,
          dueDate: invoice.dueDate,
          total: invoice.netTotal,
          paid: invoice.paidAmount,
          balance: invoice.balance,
          overdue: isOverdue(invoice.dueDate, invoice.balance),
        })),
      );
    } else {
      const invoices = await this.salesInvoiceModel
        .find({ customerId: party._id, status: VoucherStatus.POSTED, balance: { $gt: 0 } })
        .lean()
        .exec();
      bills.push(
        ...invoices.map((invoice) => ({
          type: AllocationTargetType.SALES_INVOICE,
          id: invoice._id.toString(),
          number: invoice.voucherNo,
          billNo: invoice.voucherNo,
          date: invoice.voucherDate,
          dueDate: invoice.dueDate,
          total: invoice.netTotal,
          paid: invoice.paidAmount,
          balance: invoice.balance,
          overdue: isOverdue(invoice.dueDate, invoice.balance),
        })),
      );
    }
    const openings = await this.openingModel
      .find({
        status: VoucherStatus.POSTED,
        'lines.accountId': party.ledgerAccountId,
      })
      .lean()
      .exec();
    for (const opening of openings) {
      const total = billAmount(party, opening);
      const paid = paidOn.get(`${AllocationTargetType.OPENING_BALANCE}:${opening._id.toString()}`) ?? 0;
      const balance = round2(total - paid);
      if (!(balance > 0)) continue;
      bills.push({
        type: AllocationTargetType.OPENING_BALANCE,
        id: opening._id.toString(),
        number: opening.voucherNo,
        billNo: 'Opening balance',
        date: opening.asOfDate,
        dueDate: opening.asOfDate,
        total,
        paid,
        balance,
        overdue: isOverdue(opening.asOfDate, balance),
      });
    }
    return bills.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  }

  /** Posted payment lines to the party with an unallocated (on-account) remainder. */
  async unallocatedPayments(partyId: string) {
    const party = await this.party(partyId);
    const allocated = await this.activeByKey(
      party._id,
      (a) => `${a.paymentVoucherType}:${a.paymentVoucherId.toString()}:${a.paymentLineIndex}`,
    );
    const rows: {
      paymentVoucherType: string;
      paymentVoucherId: string;
      voucherNo: string;
      voucherDate: Date;
      paymentLineIndex: number;
      amount: number;
      allocated: number;
      unallocated: number;
    }[] = [];
    for (const [paymentVoucherType, source] of this.sources) {
      const { model, partyKind } = source;
      if (partyKind !== party.kind) continue;
      const vouchers = await model
        .find({
          status: VoucherStatus.POSTED,
          [source.credit?.accountField ?? 'lines.accountId']: party.ledgerAccountId,
        })
        .sort({ voucherDate: 1, voucherNo: 1 })
        .lean<VoucherDocument[]>()
        .exec();
      for (const voucher of vouchers) {
        linesOf(source, voucher).forEach((line, paymentLineIndex) => {
          if (!line.accountId.equals(party.ledgerAccountId)) return;
          const done = allocated.get(`${paymentVoucherType}:${voucher._id.toString()}:${paymentLineIndex}`) ?? 0;
          const unallocated = round2(line.netAmount - done);
          if (!(unallocated > 0)) return;
          rows.push({
            paymentVoucherType,
            paymentVoucherId: voucher._id.toString(),
            voucherNo: voucher.voucherNo,
            voucherDate: voucher.voucherDate,
            paymentLineIndex,
            amount: line.netAmount,
            allocated: done,
            unallocated,
          });
        });
      }
    }
    return rows;
  }

  /** POST /allocations: an existing on-account payment line applied to a bill. */
  create(dto: CreateAllocationDto, actor: Actor): Promise<AllocationDocument> {
    return runInTransaction(this.connection, (session) =>
      this.allocate(
        dto.paymentVoucherType,
        new Types.ObjectId(dto.paymentVoucherId),
        {
          lineIndex: dto.paymentLineIndex,
          targetType: dto.targetType,
          targetId: dto.targetId,
          amount: dto.amount,
        },
        actor,
        session,
      ),
    );
  }

  async reverse(id: string, reason: string, actor: Actor): Promise<AllocationDocument> {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException(`Allocation id "${id}" is not a valid id`);
    return runInTransaction(this.connection, async (session) => {
      const allocation = await this.model.findById(id).session(session).exec();
      if (!allocation) throw new NotFoundException(`Allocation ${id} not found`);
      if (allocation.status !== AllocationStatus.ACTIVE) {
        throw new BadRequestException(`Allocation ${id} is already reversed`);
      }
      await this.reverseOne(allocation, reason.trim(), actor, session);
      return allocation;
    });
  }

  /** Inside a payment's create/edit transaction: each line's requested allocations. */
  async allocateForPayment(
    paymentVoucherType: string,
    voucher: VoucherDocument,
    requests: readonly LineAllocation[],
    actor: Actor,
    session: ClientSession,
  ): Promise<void> {
    for (const request of requests) {
      await this.allocate(paymentVoucherType, voucher._id, request, actor, session);
    }
  }

  /** One allocation inside the caller's transaction, returning the row (a return keeps its id as its auto-allocation). */
  allocateLine(
    paymentVoucherType: string,
    paymentVoucherId: Types.ObjectId,
    request: LineAllocation,
    actor: Actor,
    session: ClientSession,
  ): Promise<AllocationDocument> {
    return this.allocate(paymentVoucherType, paymentVoucherId, request, actor, session);
  }

  /** Ids and bill numbers of a payment's active allocations, read inside the caller's transaction. */
  async activeForPayment(
    paymentVoucherType: string,
    paymentVoucherId: Types.ObjectId,
    session: ClientSession,
  ): Promise<{ id: string; targetNo: string }[]> {
    const rows = await this.model
      .find({ paymentVoucherType, paymentVoucherId, status: AllocationStatus.ACTIVE })
      .select('targetNo')
      .session(session)
      .lean()
      .exec();
    return rows.map((row) => ({ id: row._id.toString(), targetNo: row.targetNo }));
  }

  /** Inside a payment's edit/cancel transaction: reverses every active allocation of the payment. */
  async reverseForPayment(
    paymentVoucherType: string,
    paymentVoucherId: Types.ObjectId,
    reason: string,
    actor: Actor,
    session: ClientSession,
  ): Promise<void> {
    const active = await this.model
      .find({
        paymentVoucherType,
        paymentVoucherId,
        status: AllocationStatus.ACTIVE,
      })
      .session(session)
      .exec();
    for (const allocation of active) {
      await this.reverseOne(allocation, reason, actor, session);
    }
  }

  /** Readable form of a payment's active allocations (for its edit diff); "" when none. */
  async describePayment(paymentVoucherType: string, paymentVoucherId: string): Promise<string> {
    if (!Types.ObjectId.isValid(paymentVoucherId)) return '';
    const active = await this.model
      .find({
        paymentVoucherType,
        paymentVoucherId: new Types.ObjectId(paymentVoucherId),
        status: AllocationStatus.ACTIVE,
      })
      .lean()
      .exec();
    return describe(
      active.map((a) => ({
        lineIndex: a.paymentLineIndex,
        no: a.targetNo,
        amount: a.amount,
      })),
    );
  }

  /** Readable form of requested allocations, matching describePayment. */
  async describeRequests(requests: readonly LineAllocation[]): Promise<string> {
    const rows = [];
    for (const request of requests) {
      rows.push({
        lineIndex: request.lineIndex,
        no: await this.targetNo(request),
        amount: round2(request.amount),
      });
    }
    return describe(rows);
  }

  /** A payment's active allocations, by line position (the payment form edits them). */
  async forPayment(paymentVoucherType: string, paymentVoucherId: Types.ObjectId) {
    const rows = await this.model
      .find({
        paymentVoucherType,
        paymentVoucherId,
        status: AllocationStatus.ACTIVE,
      })
      .sort({ createdAt: 1 })
      .lean()
      .exec();
    return rows.map((row) => ({
      id: row._id.toString(),
      paymentLineIndex: row.paymentLineIndex,
      targetType: row.targetType,
      targetId: row.targetId.toString(),
      targetNo: row.targetNo,
      amount: row.amount,
    }));
  }

  /** Every allocation (active and reversed) against a bill, oldest first. */
  async forTarget(targetType: AllocationTargetType, targetId: Types.ObjectId) {
    const rows = await this.model.find({ targetType, targetId }).sort({ createdAt: 1 }).lean().exec();
    return rows.map((row) => ({
      id: row._id.toString(),
      paymentVoucherType: row.paymentVoucherType,
      paymentVoucherId: row.paymentVoucherId.toString(),
      paymentVoucherNo: row.paymentVoucherNo,
      paymentLineIndex: row.paymentLineIndex,
      amount: row.amount,
      status: row.status,
      createdBy: userRefOf(row.createdBy),
      createdAt: row.createdAt,
      reversedBy: userRefOf(row.reversedBy),
      reversedAt: row.reversedAt,
      reverseReason: row.reverseReason,
    }));
  }

  /** A bill with active allocations can't be edited or cancelled; the message names the payments. */
  async assertNoActive(
    targetType: AllocationTargetType,
    targetId: Types.ObjectId,
    label: string,
    action: string,
    session: ClientSession,
  ): Promise<void> {
    const active = await this.model
      .find({ targetType, targetId, status: AllocationStatus.ACTIVE })
      .select('paymentVoucherNo')
      .session(session)
      .lean()
      .exec();
    if (active.length > 0) {
      const payments = [...new Set(active.map((a) => a.paymentVoucherNo))].join(', ');
      throw new ConflictException(
        `${label} has payments allocated (${payments}); reverse those allocations before it can be ${action}`,
      );
    }
  }

  private async allocate(
    paymentVoucherType: string,
    paymentVoucherId: Types.ObjectId,
    request: LineAllocation,
    actor: Actor,
    session: ClientSession,
  ): Promise<AllocationDocument> {
    const amount = round2(request.amount);
    if (!(amount > 0)) throw new BadRequestException('An allocation amount must be greater than 0');
    const source = this.sources.get(paymentVoucherType);
    if (!source) throw new BadRequestException(`Unknown payment type "${paymentVoucherType}"`);
    const voucher = await source.model.findById(paymentVoucherId).session(session).exec();
    if (!voucher) throw new NotFoundException(`Payment ${paymentVoucherId.toString()} not found`);
    if (voucher.status !== VoucherStatus.POSTED) {
      throw new BadRequestException(`${voucher.voucherNo} is cancelled; its lines can't be allocated`);
    }
    const lineLabel = `Line ${request.lineIndex + 1} of ${voucher.voucherNo}`;
    const line = linesOf(source, voucher)[request.lineIndex];
    if (!line) throw new BadRequestException(`${voucher.voucherNo} has no line ${request.lineIndex + 1}`);
    const party = await this.partyModel.findOne({ ledgerAccountId: line.accountId }).session(session).exec();
    if (!party) throw new BadRequestException(`${lineLabel} is not to a customer or supplier and can't be allocated`);
    if (party.kind !== source.partyKind) {
      throw new BadRequestException(`${lineLabel} is to a ${party.kind}; only ${source.partyKind} lines can be allocated here`);
    }

    const allocated = await this.sumActive(
      {
        paymentVoucherType,
        paymentVoucherId,
        paymentLineIndex: request.lineIndex,
      },
      session,
    );
    if (allocated + amount > line.netAmount + TOLERANCE) {
      throw new BadRequestException(
        `${lineLabel}: allocations of ${round2(allocated + amount).toFixed(2)} exceed the line amount ${line.netAmount.toFixed(2)}`,
      );
    }
    const target = await this.target(request, party, session);
    if (!target.partyId.equals(party._id)) {
      throw new BadRequestException(`${target.no} belongs to another party than ${lineLabel} (${party.name})`);
    }
    if (amount > target.balance + TOLERANCE) {
      throw new BadRequestException(
        `${amount.toFixed(2)} is more than the ${target.no} balance of ${target.balance.toFixed(2)}`,
      );
    }

    const now = new Date();
    const [allocation] = await this.model.create(
      [
        {
          paymentVoucherType,
          paymentVoucherId,
          paymentVoucherNo: voucher.voucherNo,
          paymentLineIndex: request.lineIndex,
          partyId: party._id,
          targetType: request.targetType,
          targetId: new Types.ObjectId(request.targetId),
          targetNo: target.no,
          amount,
          status: AllocationStatus.ACTIVE,
          createdBy: toUserSnapshot(actor),
          createdAt: now,
        },
      ],
      { session },
    );
    await this.audit(allocation, AuditAction.CREATED, actor, now, session);
    if (target.invoice) await this.applyToInvoice(target.invoice, amount, allocation, actor, now, session);
    return allocation;
  }

  private async reverseOne(allocation: AllocationDocument, reason: string, actor: Actor, session: ClientSession) {
    const now = new Date();
    allocation.status = AllocationStatus.REVERSED;
    allocation.reversedBy = toUserSnapshot(actor);
    allocation.reversedAt = now;
    allocation.reverseReason = reason;
    await allocation.save({ session });
    await this.audit(allocation, AuditAction.CANCELLED, actor, now, session, reason);
    const invoiceModel = this.invoiceModelOf(allocation.targetType);
    if (invoiceModel) {
      const invoice = await invoiceModel.findById(allocation.targetId).session(session).exec();
      if (invoice) await this.applyToInvoice(invoice, -allocation.amount, allocation, actor, now, session, reason);
    }
  }

  private invoiceModelOf(targetType: AllocationTargetType): Model<InvoiceDocument> | null {
    if (targetType === AllocationTargetType.PURCHASE_INVOICE) return this.invoiceModel as unknown as Model<InvoiceDocument>;
    if (targetType === AllocationTargetType.SALES_INVOICE) return this.salesInvoiceModel as unknown as Model<InvoiceDocument>;
    return null;
  }

  /** Moves the invoice's paid amount, balance and status; audited on the invoice. */
  private async applyToInvoice(
    invoice: InvoiceDocument,
    delta: number,
    allocation: AllocationDocument,
    actor: Actor,
    at: Date,
    session: ClientSession,
    reason?: string,
  ) {
    // A credit note settles the bill as "credited"; both reduce what is still owed.
    const field = CREDIT_NOTE_TYPES.includes(allocation.paymentVoucherType) ? 'creditedAmount' : 'paidAmount';
    const from = invoice[field] ?? 0;
    const paid = round2(from + delta);
    invoice[field] = paid;
    const settled = round2((invoice.paidAmount ?? 0) + (invoice.creditedAmount ?? 0));
    invoice.balance = round2(invoice.netTotal - settled);
    invoice.paymentStatus = paymentStatusOf(invoice.netTotal, settled);
    await invoice.save({ session });
    await this.auditService.record(
      {
        entityType: 'customerId' in invoice && invoice.customerId ? SALES_INVOICE_ENTITY_TYPE : PURCHASE_INVOICE_ENTITY_TYPE,
        entityId: invoice._id,
        entityRef: invoice.voucherNo,
        action: AuditAction.UPDATED,
        actor,
        at,
        changes: [{ field, label: field === 'creditedAmount' ? 'Credited' : 'Paid', from, to: paid }],
        reason: `${delta > 0 ? 'Allocated from' : 'Allocation reversed:'} ${allocation.paymentVoucherNo}${reason ? ` (${reason})` : ''}`,
      },
      session,
    );
  }

  private async target(request: LineAllocation, party: PartyDocument, session: ClientSession): Promise<Target> {
    if (!Types.ObjectId.isValid(request.targetId)) {
      throw new BadRequestException(`Bill id "${request.targetId}" is not a valid id`);
    }
    const targetId = new Types.ObjectId(request.targetId);
    if (request.targetType === AllocationTargetType.PURCHASE_INVOICE) {
      const invoice = await this.invoiceModel.findById(targetId).session(session).exec();
      if (!invoice) throw new NotFoundException(`Purchase invoice ${request.targetId} not found`);
      if (invoice.status !== VoucherStatus.POSTED) throw new BadRequestException(`${invoice.voucherNo} is cancelled`);
      return {
        no: invoice.voucherNo,
        partyId: invoice.supplierId,
        balance: invoice.balance,
        invoice,
      };
    }
    if (request.targetType === AllocationTargetType.SALES_INVOICE) {
      const invoice = await this.salesInvoiceModel.findById(targetId).session(session).exec();
      if (!invoice) throw new NotFoundException(`Sales invoice ${request.targetId} not found`);
      if (invoice.status !== VoucherStatus.POSTED) throw new BadRequestException(`${invoice.voucherNo} is cancelled`);
      return { no: invoice.voucherNo, partyId: invoice.customerId, balance: invoice.balance, invoice };
    }
    const opening = await this.openingModel.findById(targetId).session(session).lean().exec();
    if (!opening) throw new NotFoundException(`Opening balance ${request.targetId} not found`);
    if (opening.status !== VoucherStatus.POSTED) throw new BadRequestException(`${opening.voucherNo} is cancelled`);
    const total = billAmount(party, opening);
    if (!(total > 0)) {
      throw new BadRequestException(`${opening.voucherNo} holds no opening balance owed for ${party.name}`);
    }
    const paid = await this.sumActive({ targetType: request.targetType, targetId, partyId: party._id }, session);
    return {
      no: opening.voucherNo,
      partyId: party._id,
      balance: round2(total - paid),
      invoice: null,
    };
  }

  private async targetNo(request: LineAllocation): Promise<string> {
    if (!Types.ObjectId.isValid(request.targetId)) return request.targetId;
    const model = (this.invoiceModelOf(request.targetType) ?? this.openingModel) as unknown as Model<{ voucherNo: string }>;
    const doc = await model.findById(request.targetId).select('voucherNo').lean().exec();
    return doc?.voucherNo ?? request.targetId;
  }

  private async sumActive(filter: Record<string, unknown>, session: ClientSession): Promise<number> {
    const rows = await this.model
      .find({ ...filter, status: AllocationStatus.ACTIVE })
      .select('amount')
      .session(session)
      .lean()
      .exec();
    return sum2(rows.map((row) => row.amount));
  }

  /** The party's active allocation amounts, summed per key. */
  private async activeByKey(partyId: Types.ObjectId, key: (allocation: Allocation) => string) {
    const rows = await this.model.find({ partyId, status: AllocationStatus.ACTIVE }).lean().exec();
    const sums = new Map<string, number>();
    for (const row of rows) sums.set(key(row), round2((sums.get(key(row)) ?? 0) + row.amount));
    return sums;
  }

  private async party(partyId: string): Promise<PartyDocument> {
    if (!Types.ObjectId.isValid(partyId)) throw new BadRequestException(`Party id "${partyId}" is not a valid id`);
    const party = await this.partyModel.findById(partyId).exec();
    if (!party) throw new NotFoundException(`Party ${partyId} not found`);
    return party;
  }

  private audit(
    allocation: AllocationDocument,
    action: AuditAction,
    actor: Actor,
    at: Date,
    session: ClientSession,
    reason?: string,
  ) {
    return this.auditService.record(
      {
        entityType: ALLOCATION_ENTITY_TYPE,
        entityId: allocation._id,
        entityRef: `${allocation.paymentVoucherNo} > ${allocation.targetNo}`,
        action,
        actor,
        at,
        changes: [
          {
            field: 'amount',
            label: 'Amount',
            from: null,
            to: allocation.amount,
          },
        ],
        reason,
      },
      session,
    );
  }
}

/** What the party owes on an opening voucher: a supplier's credit, a customer's debit. */
function billAmount(
  party: { kind: PartyKind; ledgerAccountId: Types.ObjectId },
  opening: {
    lines: { accountId: Types.ObjectId; debit: number; credit: number }[];
  },
): number {
  const line = opening.lines.find((candidate) => candidate.accountId.equals(party.ledgerAccountId));
  if (!line) return 0;
  return party.kind === PartyKind.SUPPLIER ? line.credit : line.debit;
}

function describe(rows: { lineIndex: number; no: string; amount: number }[]): string {
  return rows
    .map((row) => `Line ${row.lineIndex + 1}: ${row.no} ${row.amount.toFixed(2)}`)
    .sort()
    .join('; ');
}
