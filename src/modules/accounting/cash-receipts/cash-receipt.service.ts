import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model, QueryFilter, SortOrder } from 'mongoose';
import {
  CASH_RECEIPT_ENTITY_TYPE,
  CashReceipt,
  CashReceiptDocument,
  CashReceiptLine,
  CashReceiptStatus,
  PaymentMethod,
  paymentMethodFor,
} from './schemas/cash-receipt.schema.js';
import { CashReceiptLineDto, CreateCashReceiptDto } from './dto/create-cash-receipt.dto.js';
import { CANCEL_REASON_MIN_LENGTH, CancelCashReceiptDto, UpdateCashReceiptDto } from './dto/update-cash-receipt.dto.js';
import { CashReceiptQueryDto } from './dto/cash-receipt-query.dto.js';
import { diffCashReceipt, type DiffableCashReceipt } from './cash-receipt.diff.js';
import { LedgerAccountService } from '../ledger-accounts/ledger-account.service.js';
import { LedgerAccountUsageRegistry } from '../ledger-accounts/ledger-account-usage.registry.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import type { CodeSequence } from '../../sequence/code-sequence.js';
import { escapeRegExp } from '../../sequence/code-sequence.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction } from '../../audit/schemas/audit-log.schema.js';
import { CommentsService } from '../../comments/comments.service.js';
import { EntityAccessRegistry } from '../../comments/entity-access.registry.js';
import { CashierService } from '../../cashier/cashier.service.js';
import { CashierUsageRegistry } from '../../cashier/cashier-usage.registry.js';
import {
  type Actor,
  type UserSnapshot,
  toUserSnapshot,
  userRefOf,
} from '../../../common/schemas/user-snapshot.schema.js';
import { round2, sum2 } from '../../../common/utils/money.util.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';

export const CASH_RECEIPT_VOUCHER_SEQUENCE: CodeSequence = {
  key: 'cash-receipt',
  prefix: 'CR',
  width: 6,
};

interface PricedLine {
  accountId: string;
  narration?: string;
  remarks?: string;
  amount: number;
  vat: number;
  netAmount: number;
}

type UserRef = { id: string; name: string } | null;

export interface CashReceiptListRow {
  id: string;
  voucherNo: string;
  date: Date;
  cashAccount: { id: string; name: string | null };
  /** id is null on receipts from before the cashier master; name is their old free text. */
  cashier: { id: string | null; name: string | null };
  paymentMethod: PaymentMethod;
  /** First line's account, plus how many other distinct accounts the receipt touches. */
  partiesSummary: {
    firstAccount: { id: string; name: string | null } | null;
    othersCount: number;
  };
  grandTotal: number;
  status: CashReceiptStatus;
  /** null on receipts created before audit tracking: show as unknown. */
  createdBy: UserRef;
  createdAt: Date | null;
  updatedBy: UserRef;
  updatedAt: Date | null;
  commentCount: number;
}

export interface CashReceiptPage {
  items: CashReceiptListRow[];
  page: number;
  pageSize: number;
  /** count: every receipt matching the filter; total: their grand totals, cancelled ones excluded. */
  summary: { count: number; total: number };
}

type LeanCashReceipt = CashReceipt & { _id: Types.ObjectId };

const SORT_FIELDS: Record<NonNullable<CashReceiptQueryDto['sortBy']>, string[]> = {
  date: ['voucherDate', 'voucherNo'],
  amount: ['grandTotal', 'voucherNo'],
  voucherNo: ['voucherNo'],
};

@Injectable()
export class CashReceiptService {
  constructor(
    @InjectModel(CashReceipt.name)
    private readonly cashReceiptModel: Model<CashReceiptDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly ledgerAccountService: LedgerAccountService,
    private readonly sequenceService: SequenceService,
    private readonly auditService: AuditService,
    private readonly commentsService: CommentsService,
    private readonly cashierService: CashierService,
    usageRegistry: LedgerAccountUsageRegistry,
    cashierUsage: CashierUsageRegistry,
    entityAccess: EntityAccessRegistry,
  ) {
    // Blocks deleting a cashier any receipt was posted against.
    cashierUsage.register('cash receipts', async (cashierId, session) =>
      Boolean(
        await this.cashReceiptModel
          .exists({ cashierId })
          .session(session ?? null)
          .exec(),
      ),
    );

    // Blocks deleting an account any receipt posted to, on either side.
    usageRegistry.register('cash receipts', async (accountId, session) =>
      Boolean(
        await this.cashReceiptModel
          .exists({
            $or: [{ cashAccountId: accountId }, { 'lines.accountId': accountId }],
          })
          .session(session ?? null)
          .exec(),
      ),
    );

    // Comments and the activity timeline: readable by anyone logged in, the
    // same rule as GET /cash-receipts/:id.
    entityAccess.register(CASH_RECEIPT_ENTITY_TYPE, {
      exists: async (id) => Boolean(await this.cashReceiptModel.exists({ _id: id }).exec()),
      canRead: () => true,
    });
  }

  async findAll(query: CashReceiptQueryDto = {}): Promise<CashReceiptPage> {
    const filter = this.listFilter(query);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const direction: SortOrder = query.sortDir === 'asc' ? 1 : -1;
    const sort = Object.fromEntries(SORT_FIELDS[query.sortBy ?? 'date'].map((field) => [field, direction]));

    const [receipts, summaryRows] = await Promise.all([
      this.cashReceiptModel
        .find(filter)
        .sort(sort)
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean<LeanCashReceipt[]>()
        .exec(),
      // $match doesn't cast, so listFilter builds ObjectIds and Dates itself.
      this.cashReceiptModel
        .aggregate<{ count: number; total: number }>([
          { $match: filter },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              total: {
                $sum: {
                  $cond: [{ $eq: ['$status', CashReceiptStatus.CANCELLED] }, 0, '$grandTotal'],
                },
              },
            },
          },
        ])
        .exec(),
    ]);

    const [names, commentCounts] = await Promise.all([
      this.ledgerAccountService.getNames(
        receipts.flatMap((receipt) => [
          receipt.cashAccountId.toString(),
          ...(receipt.lines[0] ? [receipt.lines[0].accountId.toString()] : []),
        ]),
      ),
      this.commentsService.countByEntityIds(
        CASH_RECEIPT_ENTITY_TYPE,
        receipts.map((receipt) => receipt._id),
      ),
    ]);

    return {
      items: receipts.map((receipt) => this.toListRow(receipt, names, commentCounts)),
      page,
      pageSize,
      summary: {
        count: summaryRows[0]?.count ?? 0,
        total: round2(summaryRows[0]?.total ?? 0),
      },
    };
  }

  async findById(id: string): Promise<CashReceiptDocument> {
    this.assertValidId(id);
    const receipt = await this.cashReceiptModel.findById(id).exec();
    if (!receipt) {
      throw new NotFoundException(`Cash receipt ${id} not found`);
    }
    return receipt;
  }

  /** `actor` is the authenticated user; nothing in the DTO can set who created the receipt. */
  async create(dto: CreateCashReceiptDto, actor: Actor): Promise<CashReceiptDocument> {
    const receivedInto = await this.ledgerAccountService.findActiveReceiptAccount(dto.cashAccountId);
    const pricedLines = this.priceLines(dto.lines);
    this.assertHeaderNotOnLines(dto.cashAccountId, pricedLines);

    return this.withTransaction(async (session) => {
      const cashier = await this.cashierService.findActiveForPosting(dto.cashierId, session);
      const lines = await this.snapshotLines(pricedLines, session);
      // Issued on the transaction's session: if anything below aborts, the
      // counter increment rolls back too, so voucher numbers stay gapless.
      const voucherNo = await this.sequenceService.nextCode(CASH_RECEIPT_VOUCHER_SEQUENCE, session);
      const now = new Date();

      const [created] = await this.cashReceiptModel.create(
        [
          {
            voucherNo,
            voucherDate: new Date(dto.voucherDate),
            cashAccountId: new Types.ObjectId(dto.cashAccountId),
            cashierId: cashier._id,
            cashierName: cashier.name,
            paymentMethod: paymentMethodFor(receivedInto.type),
            paymentReference: dto.paymentReference ?? null,
            comments: dto.comments,
            lines,
            ...this.totalsOf(pricedLines),
            status: CashReceiptStatus.POSTED,
            createdBy: toUserSnapshot(actor),
            createdAt: now,
          },
        ],
        { session },
      );

      // Line accounts are verified here rather than up front: an unknown id makes
      // this throw, which aborts the transaction and unwinds the insert above.
      await this.ledgerAccountService.applyBalanceDeltas(this.buildDeltas(dto.cashAccountId, lines, 1), session);

      await this.auditService.record(
        {
          entityType: CASH_RECEIPT_ENTITY_TYPE,
          entityId: created._id,
          entityRef: voucherNo,
          action: AuditAction.CREATED,
          actor,
          at: now,
        },
        session,
      );

      return created;
    });
  }

  /**
   * Rejects with "No changes to save" when the edit changes nothing visible;
   * the transaction then aborts, so neither updatedAt nor the audit log moves.
   *
   * Cashier: keeping the receipt's current cashier is allowed even if it has
   * since been deactivated; switching to another needs an active one. A
   * receipt from before the cashier master must be given one to be saved.
   */
  async update(id: string, dto: UpdateCashReceiptDto, actor: Actor): Promise<CashReceiptDocument> {
    const current = await this.findById(id);
    this.assertNotCancelled(current, 'edited');

    const nextCashAccountId = dto.cashAccountId ?? current.cashAccountId.toString();
    const receivedInto = await this.ledgerAccountService.findActiveReceiptAccount(nextCashAccountId);

    const pricedLines = dto.lines ? this.priceLines(dto.lines) : null;

    return this.withTransaction(async (session) => {
      // Re-read on the session: the diff, the reversal and the save must all
      // describe the same version of the receipt.
      const existing = await this.cashReceiptModel.findById(id).session(session).exec();
      if (!existing) {
        throw new NotFoundException(`Cash receipt ${id} not found`);
      }
      this.assertNotCancelled(existing, 'edited');

      if (dto.cashierId === null) {
        throw new BadRequestException('A cash receipt must have a cashier');
      }
      let nextCashierId = existing.cashierId?.toString() ?? null;
      let nextCashierName = existing.cashierName;
      if (dto.cashierId !== undefined && dto.cashierId !== nextCashierId) {
        const cashier = await this.cashierService.findActiveForPosting(dto.cashierId, session);
        nextCashierId = cashier._id.toString();
        nextCashierName = cashier.name;
      }
      if (!nextCashierId) {
        throw new BadRequestException(
          `Cash receipt ${existing.voucherNo} was entered before cashiers were set up: choose a cashier (cashierId) to save changes`,
        );
      }

      const before = this.diffable(existing);
      const after: DiffableCashReceipt = {
        voucherDate: dto.voucherDate !== undefined ? new Date(dto.voucherDate) : existing.voucherDate,
        cashAccountId: nextCashAccountId,
        cashierId: nextCashierId,
        cashierName: nextCashierName,
        paymentReference: dto.paymentReference !== undefined ? dto.paymentReference : existing.paymentReference,
        comments: dto.comments !== undefined ? dto.comments : existing.comments,
        lines: pricedLines ?? before.lines,
      };
      this.assertHeaderNotOnLines(after.cashAccountId, after.lines);
      const names = await this.ledgerAccountService.getNames(
        [before, after].flatMap((version) => [version.cashAccountId, ...version.lines.map((line) => line.accountId)]),
        session,
      );
      const changes = diffCashReceipt(before, after, names);
      if (changes.length === 0) {
        throw new BadRequestException('No changes to save');
      }

      // Unwind the original posting first, so a replacement line's oldBalance
      // snapshot reflects the balance as if this voucher had never been posted.
      await this.ledgerAccountService.applyBalanceDeltas(
        this.buildDeltas(existing.cashAccountId.toString(), existing.lines, -1),
        session,
      );

      const nextLines = pricedLines ? await this.snapshotLines(pricedLines, session) : existing.lines;
      const now = new Date();

      existing.voucherDate = after.voucherDate;
      existing.cashierId = new Types.ObjectId(nextCashierId);
      existing.cashierName = nextCashierName;
      existing.paymentMethod = paymentMethodFor(receivedInto.type);
      existing.paymentReference = after.paymentReference ?? null;
      if (dto.comments !== undefined) existing.comments = dto.comments;
      existing.cashAccountId = new Types.ObjectId(nextCashAccountId);
      existing.lines = nextLines;

      const totals = this.totalsOf(nextLines);
      existing.grossTotal = totals.grossTotal;
      existing.totalTax = totals.totalTax;
      existing.grandTotal = totals.grandTotal;
      existing.updatedBy = toUserSnapshot(actor);
      existing.updatedAt = now;

      await existing.save({ session });

      await this.ledgerAccountService.applyBalanceDeltas(this.buildDeltas(nextCashAccountId, nextLines, 1), session);

      await this.auditService.record(
        {
          entityType: CASH_RECEIPT_ENTITY_TYPE,
          entityId: existing._id,
          entityRef: existing.voucherNo,
          action: AuditAction.UPDATED,
          actor,
          changes,
          reason: dto.changeNote,
          at: now,
        },
        session,
      );

      return existing;
    });
  }

  /** Reverses the posting and keeps the voucher, marked cancelled, with who/when/why. */
  async cancel(id: string, dto: CancelCashReceiptDto, actor: Actor): Promise<CashReceiptDocument> {
    this.assertValidId(id);
    const reason = typeof dto?.reason === 'string' ? dto.reason.trim() : '';
    if (reason.length < CANCEL_REASON_MIN_LENGTH) {
      throw new BadRequestException(
        `A cancellation reason of at least ${CANCEL_REASON_MIN_LENGTH} characters is required`,
      );
    }

    return this.withTransaction(async (session) => {
      const existing = await this.cashReceiptModel.findById(id).session(session).exec();
      if (!existing) {
        throw new NotFoundException(`Cash receipt ${id} not found`);
      }
      this.assertNotCancelled(existing, 'cancelled again');

      await this.ledgerAccountService.applyBalanceDeltas(
        this.buildDeltas(existing.cashAccountId.toString(), existing.lines, -1),
        session,
      );

      const now = new Date();
      existing.status = CashReceiptStatus.CANCELLED;
      existing.cancelledBy = toUserSnapshot(actor);
      existing.cancelledAt = now;
      existing.cancelReason = reason;
      await existing.save({ session });

      await this.auditService.record(
        {
          entityType: CASH_RECEIPT_ENTITY_TYPE,
          entityId: existing._id,
          entityRef: existing.voucherNo,
          action: AuditAction.CANCELLED,
          actor,
          changes: [
            {
              field: 'status',
              label: 'Status',
              from: CashReceiptStatus.POSTED,
              to: CashReceiptStatus.CANCELLED,
            },
          ],
          reason,
          at: now,
        },
        session,
      );

      return existing;
    });
  }

  async remove(id: string): Promise<{ success: true }> {
    const existing = await this.findById(id);

    return this.withTransaction(async (session) => {
      // A cancelled receipt's posting was already reversed when it was cancelled.
      if (existing.status !== CashReceiptStatus.CANCELLED) {
        await this.ledgerAccountService.applyBalanceDeltas(
          this.buildDeltas(existing.cashAccountId.toString(), existing.lines, -1),
          session,
        );
      }
      await this.cashReceiptModel.deleteOne({ _id: existing._id }, { session }).exec();
      return { success: true as const };
    });
  }

  private listFilter(query: CashReceiptQueryDto): QueryFilter<CashReceiptDocument> {
    const filter: QueryFilter<CashReceiptDocument> = {};

    if (query.dateFrom || query.dateTo) {
      const range: { $gte?: Date; $lte?: Date } = {};
      if (query.dateFrom) {
        range.$gte = new Date(query.dateFrom);
      }
      if (query.dateTo) {
        range.$lte = this.endOfDayIfDateOnly(query.dateTo);
      }
      if (range.$gte && range.$lte && range.$gte > range.$lte) {
        throw new BadRequestException('dateFrom must not be after dateTo');
      }
      filter.voucherDate = range;
    }

    // Receipts from before cancellation existed have no status and count as posted.
    if (query.status === 'posted') {
      filter.status = { $ne: CashReceiptStatus.CANCELLED };
    } else if (query.status === 'cancelled') {
      filter.status = CashReceiptStatus.CANCELLED;
    }

    if (query.cashAccountId) {
      filter.cashAccountId = new Types.ObjectId(query.cashAccountId);
    }
    if (query.accountId) {
      filter['lines.accountId'] = new Types.ObjectId(query.accountId);
    }
    if (query.cashierId) {
      filter.cashierId = new Types.ObjectId(query.cashierId);
    }
    if (query.createdBy) {
      filter['createdBy.id'] = new Types.ObjectId(query.createdBy);
    }

    if (query.amountMin !== undefined || query.amountMax !== undefined) {
      if (query.amountMin !== undefined && query.amountMax !== undefined && query.amountMin > query.amountMax) {
        throw new BadRequestException('amountMin must not be greater than amountMax');
      }
      const range: { $gte?: number; $lte?: number } = {};
      if (query.amountMin !== undefined) range.$gte = query.amountMin;
      if (query.amountMax !== undefined) range.$lte = query.amountMax;
      filter.grandTotal = range;
    }

    const term = query.q?.trim();
    if (term) {
      const pattern = new RegExp(escapeRegExp(term), 'i');
      filter.$or = [
        { voucherNo: pattern },
        { comments: pattern },
        { 'lines.narration': pattern },
        { paymentReference: pattern },
      ];
    }

    return filter;
  }

  private toListRow(
    receipt: LeanCashReceipt,
    names: ReadonlyMap<string, string>,
    commentCounts: ReadonlyMap<string, number>,
  ): CashReceiptListRow {
    const cashAccountId = receipt.cashAccountId.toString();
    const firstAccountId = receipt.lines[0]?.accountId.toString();
    const distinctAccounts = new Set(receipt.lines.map((line) => line.accountId.toString())).size;

    return {
      id: receipt._id.toString(),
      voucherNo: receipt.voucherNo,
      date: receipt.voucherDate,
      cashAccount: {
        id: cashAccountId,
        name: names.get(cashAccountId) ?? null,
      },
      cashier: { id: receipt.cashierId?.toString() ?? null, name: receipt.cashierName ?? null },
      paymentMethod: receipt.paymentMethod ?? PaymentMethod.CASH,
      partiesSummary: {
        firstAccount: firstAccountId ? { id: firstAccountId, name: names.get(firstAccountId) ?? null } : null,
        othersCount: Math.max(distinctAccounts - 1, 0),
      },
      grandTotal: receipt.grandTotal,
      status: receipt.status ?? CashReceiptStatus.POSTED,
      createdBy: userRefOf(receipt.createdBy as UserSnapshot | null | undefined),
      createdAt: receipt.createdAt ?? null,
      updatedBy: userRefOf(receipt.updatedBy as UserSnapshot | null | undefined),
      updatedAt: receipt.updatedAt ?? null,
      commentCount: commentCounts.get(receipt._id.toString()) ?? 0,
    };
  }

  private diffable(receipt: CashReceiptDocument): DiffableCashReceipt {
    return {
      voucherDate: receipt.voucherDate,
      cashAccountId: receipt.cashAccountId.toString(),
      cashierId: receipt.cashierId?.toString() ?? null,
      cashierName: receipt.cashierName,
      paymentReference: receipt.paymentReference,
      comments: receipt.comments,
      lines: receipt.lines.map((line) => ({
        accountId: line.accountId.toString(),
        amount: line.amount,
        vat: line.vat,
        narration: line.narration,
        remarks: line.remarks,
      })),
    };
  }

  /** The account the money is received into can't also be one of the accounts it is received from. */
  private assertHeaderNotOnLines(headerAccountId: string, lines: readonly { accountId: string }[]): void {
    if (lines.some((line) => line.accountId === headerAccountId)) {
      throw new BadRequestException('The "received into" account cannot also be used on a line');
    }
  }

  private assertValidId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Cash receipt id "${id}" is not a valid id`);
    }
  }

  private assertNotCancelled(receipt: CashReceiptDocument, action: string): void {
    if (receipt.status === CashReceiptStatus.CANCELLED) {
      throw new BadRequestException(`Cash receipt ${receipt.voucherNo} is cancelled and cannot be ${action}`);
    }
  }

  private priceLines(lines: readonly CashReceiptLineDto[]): PricedLine[] {
    return lines.map((line) => {
      const amount = round2(line.amount);
      const vat = round2(line.vat ?? 0);
      if (!(amount > 0) || vat < 0) {
        throw new BadRequestException('Each line needs a positive amount and a VAT of 0 or more');
      }
      return {
        accountId: line.accountId,
        narration: line.narration,
        remarks: line.remarks,
        amount,
        vat,
        netAmount: round2(amount + vat),
      };
    });
  }

  private totalsOf(lines: readonly Pick<PricedLine, 'amount' | 'vat' | 'netAmount'>[]) {
    return {
      grossTotal: sum2(lines.map((line) => line.amount)),
      totalTax: sum2(lines.map((line) => line.vat)),
      grandTotal: sum2(lines.map((line) => line.netAmount)),
    };
  }

  private async snapshotLines(pricedLines: readonly PricedLine[], session: ClientSession): Promise<CashReceiptLine[]> {
    const balances = await this.ledgerAccountService.getBalances(
      pricedLines.map((line) => line.accountId),
      session,
    );

    return pricedLines.map((line) => ({
      accountId: new Types.ObjectId(line.accountId),
      narration: line.narration,
      remarks: line.remarks,
      oldBalance: balances.get(line.accountId) ?? 0,
      amount: line.amount,
      vat: line.vat,
      netAmount: line.netAmount,
    }));
  }

  /**
   * Cash in: the cash account gains the grand total, each line account is
   * relieved by its net amount. sign -1 reverses an existing posting.
   */
  private buildDeltas(cashAccountId: string, lines: readonly CashReceiptLine[], sign: 1 | -1): Map<string, number> {
    const deltas = new Map<string, number>();
    const accumulate = (accountId: string, delta: number) => {
      deltas.set(accountId, round2((deltas.get(accountId) ?? 0) + delta));
    };

    const grandTotal = sum2(lines.map((line) => line.netAmount));
    accumulate(cashAccountId, sign * grandTotal);

    for (const line of lines) {
      accumulate(line.accountId.toString(), sign * -line.netAmount);
    }

    return deltas;
  }

  private withTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    return runInTransaction(this.connection, work);
  }

  /** A date-only filter bound should cover the whole day, not just its midnight boundary. */
  private endOfDayIfDateOnly(value: string): Date {
    const date = new Date(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      date.setUTCHours(23, 59, 59, 999);
    }
    return date;
  }
}
