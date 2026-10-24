import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import {
  OPENING_BALANCE_ENTITY_TYPE,
  OPENING_BALANCE_EQUITY_KEY,
  OPENING_BALANCE_EQUITY_NAME,
  OpeningBalance,
  OpeningBalanceDocument,
  type OpeningBalanceLine,
} from './schemas/opening-balance.schema.js';
import {
  CancelOpeningBalanceDto,
  CreateOpeningBalanceDto,
  OpeningBalanceQueryDto,
  UpdateOpeningBalanceDto,
  ValidateOpeningBalanceDto,
} from './dto/opening-balance.dto.js';
import { VoucherPostingService, type VoucherPage } from '../vouchers/voucher-posting.service.js';
import { VoucherStatus } from '../vouchers/schemas/voucher.schema.js';
import { LedgerEntryKind } from '../vouchers/schemas/ledger-entry.schema.js';
import { withScope, type ScopedUser } from '../vouchers/data-scope.js';
import { LedgerAccountService } from '../ledger-accounts/ledger-account.service.js';
import { LedgerAccountType } from '../ledger-accounts/schemas/ledger-account.schema.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { escapeRegExp } from '../../sequence/code-sequence.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction, type AuditChange } from '../../audit/schemas/audit-log.schema.js';
import { CommentsService } from '../../comments/comments.service.js';
import { EntityAccessRegistry } from '../../comments/entity-access.registry.js';
import { Permission, hasPermission } from '../../roles/permissions.js';
import { type Actor, type UserSnapshot, toUserSnapshot, userRefOf } from '../../../common/schemas/user-snapshot.schema.js';
import { round2, sum2 } from '../../../common/utils/money.util.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';

type Viewer = Actor & ScopedUser;

const SEQUENCE = { key: 'opening-balance', prefix: 'OB-', width: 4 };
const LABEL = 'Opening balance';

/** Cheque accounts are not here: pending cheques are entered as cheque receipts. */
const OPENING_ACCOUNT_TYPES: readonly LedgerAccountType[] = [
  LedgerAccountType.CASH,
  LedgerAccountType.WALLET,
  LedgerAccountType.BANK,
  LedgerAccountType.PARTY,
  LedgerAccountType.SUPPLIER,
  LedgerAccountType.EXPENSE,
  LedgerAccountType.INCOME,
  LedgerAccountType.OTHER,
];

interface LineInput {
  accountId?: string;
  accountCode?: string;
  debit?: number;
  credit?: number;
}

export interface CheckedLine {
  row: number;
  accountCode: string | null;
  accountId: string | null;
  accountName: string | null;
  accountType: LedgerAccountType | null;
  debit: number;
  credit: number;
}

export interface RowError {
  row: number;
  accountCode: string | null;
  message: string;
}

export interface OpeningBalanceListRow {
  id: string;
  voucherNo: string;
  asOfDate: Date;
  lineCount: number;
  totalDebit: number;
  totalCredit: number;
  equityDebit: number;
  equityCredit: number;
  status: VoucherStatus;
  createdBy: { id: string; name: string } | null;
  createdAt: Date | null;
  updatedBy: { id: string; name: string } | null;
  updatedAt: Date | null;
  commentCount: number;
}

/**
 * Opening balance vouchers. Each posts its lines plus one balancing entry on
 * the system Opening Balance Equity account, in one transaction with its
 * number and audit entry. Edit = reverse + repost; cancel reverses; no delete.
 */
@Injectable()
export class OpeningBalanceService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(OpeningBalance.name) private readonly model: Model<OpeningBalanceDocument>,
    private readonly posting: VoucherPostingService,
    private readonly ledgerAccountService: LedgerAccountService,
    private readonly sequenceService: SequenceService,
    private readonly auditService: AuditService,
    private readonly commentsService: CommentsService,
    entityAccess: EntityAccessRegistry,
  ) {
    entityAccess.register(OPENING_BALANCE_ENTITY_TYPE, {
      exists: async (id, user) =>
        Boolean(await this.model.exists(withScope({ _id: id }, await this.posting.scopeFilter(user))).exec()),
      canRead: (user) => hasPermission(user, Permission.OPENING_BALANCES_READ),
    });
  }

  async findAll(query: OpeningBalanceQueryDto = {}, viewer?: Viewer): Promise<VoucherPage<OpeningBalanceListRow>> {
    const filter: Record<string, unknown> = {};
    if (query.dateFrom || query.dateTo) {
      const range: { $gte?: Date; $lte?: Date } = {};
      if (query.dateFrom) range.$gte = new Date(query.dateFrom);
      if (query.dateTo) range.$lte = endOfDayIfDateOnly(query.dateTo);
      if (range.$gte && range.$lte && range.$gte > range.$lte) {
        throw new BadRequestException('dateFrom must not be after dateTo');
      }
      filter.asOfDate = range;
    }
    if (query.status === 'posted') filter.status = VoucherStatus.POSTED;
    else if (query.status === 'cancelled') filter.status = VoucherStatus.CANCELLED;
    if (query.accountId) filter['lines.accountId'] = new Types.ObjectId(query.accountId);
    const term = query.q?.trim();
    if (term) {
      const pattern = new RegExp(escapeRegExp(term), 'i');
      filter.$or = [{ voucherNo: pattern }, { comments: pattern }];
    }
    const scoped = withScope(filter, await this.posting.scopeFilter(viewer));
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const [docs, count, totals] = await Promise.all([
      this.model
        .find(scoped)
        .sort({ asOfDate: -1, voucherNo: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean()
        .exec(),
      this.model.countDocuments(scoped).exec(),
      this.model
        .aggregate<{ total: number }>([
          { $match: scoped },
          { $match: { status: VoucherStatus.POSTED } },
          { $group: { _id: null, total: { $sum: '$totalDebit' } } },
        ])
        .exec(),
    ]);
    const comments = await this.commentsService.countByEntityIds(
      OPENING_BALANCE_ENTITY_TYPE,
      docs.map((doc) => doc._id),
    );
    return {
      items: docs.map((doc) => ({
        id: doc._id.toString(),
        voucherNo: doc.voucherNo,
        asOfDate: doc.asOfDate,
        lineCount: doc.lines.length,
        totalDebit: doc.totalDebit,
        totalCredit: doc.totalCredit,
        equityDebit: doc.equityDebit,
        equityCredit: doc.equityCredit,
        status: doc.status,
        createdBy: userRefOf(doc.createdBy as UserSnapshot | null),
        createdAt: doc.createdAt ?? null,
        updatedBy: userRefOf(doc.updatedBy as UserSnapshot | null),
        updatedAt: doc.updatedAt ?? null,
        commentCount: comments.get(doc._id.toString()) ?? 0,
      })),
      page,
      pageSize,
      summary: { count, total: round2(totals[0]?.total ?? 0) },
    };
  }

  async findById(id: string, viewer?: Viewer): Promise<OpeningBalanceDocument> {
    assertValidId(id);
    const doc = await this.model
      .findOne(withScope({ _id: new Types.ObjectId(id) }, await this.posting.scopeFilter(viewer)))
      .exec();
    if (!doc) {
      throw new NotFoundException(`${LABEL} ${id} not found`);
    }
    return doc;
  }

  /** Lines by account code, resolved and checked like a save would; nothing is posted. */
  async validate(dto: ValidateOpeningBalanceDto) {
    const { lines, errors } = await this.check(dto.lines, dto.voucherId ? new Types.ObjectId(dto.voucherId) : null);
    return { valid: errors.length === 0, lines, errors, ...totalsOf(lines) };
  }

  async create(dto: CreateOpeningBalanceDto, actor: Viewer): Promise<OpeningBalanceDocument> {
    assertNotFuture(dto.asOfDate);

    return runInTransaction(this.connection, async (session) => {
      const lines = await this.checkedLines(dto.lines, null, session);
      const equity = await this.ledgerAccountService.ensureSystemAccount(
        OPENING_BALANCE_EQUITY_KEY,
        OPENING_BALANCE_EQUITY_NAME,
        LedgerAccountType.OTHER,
        session,
      );
      const voucherNo = await this.sequenceService.nextCode(SEQUENCE, session);
      const now = new Date();
      const [created] = await this.model.create(
        [
          {
            voucherNo,
            asOfDate: new Date(dto.asOfDate),
            comments: dto.comments,
            lines,
            ...totalsOf(lines),
            equityAccountId: equity._id,
            status: VoucherStatus.POSTED,
            createdBy: toUserSnapshot(actor),
            createdAt: now,
          },
        ],
        { session },
      );
      await this.post(created, LedgerEntryKind.POSTING, 'created', session);
      await this.record(created, AuditAction.CREATED, actor, now, session);
      return created;
    });
  }

  /** Reverses the old posting and posts the new one; an edit that changes nothing is rejected. */
  async update(id: string, dto: UpdateOpeningBalanceDto, actor: Viewer): Promise<OpeningBalanceDocument> {
    if (dto.asOfDate !== undefined) assertNotFuture(dto.asOfDate);
    const scope = await this.posting.scopeFilter(actor);

    return runInTransaction(this.connection, async (session) => {
      const existing = await this.load(id, scope, session);
      assertNotCancelled(existing, 'edited');
      const nextLines = dto.lines ? await this.checkedLines(dto.lines, existing._id, session) : existing.lines;
      const nextDate = dto.asOfDate !== undefined ? new Date(dto.asOfDate) : existing.asOfDate;
      const nextComments = dto.comments !== undefined ? dto.comments : existing.comments;

      const changes = await this.diff(existing, { asOfDate: nextDate, comments: nextComments, lines: nextLines }, session);
      if (changes.length === 0) {
        throw new BadRequestException('No changes to save');
      }

      await this.post(existing, LedgerEntryKind.REVERSAL, 'updated', session);
      const now = new Date();
      existing.asOfDate = nextDate;
      existing.comments = nextComments;
      existing.lines = nextLines;
      existing.set(totalsOf(nextLines));
      existing.updatedBy = toUserSnapshot(actor);
      existing.updatedAt = now;
      await existing.save({ session });
      await this.post(existing, LedgerEntryKind.POSTING, 'updated', session);
      await this.record(existing, AuditAction.UPDATED, actor, now, session, { changes, reason: dto.changeNote });
      return existing;
    });
  }

  /** Reverses the posting and keeps the voucher, marked cancelled, with who/when/why. */
  async cancel(id: string, dto: CancelOpeningBalanceDto, actor: Viewer): Promise<OpeningBalanceDocument> {
    const reason = dto.reason.trim();
    const scope = await this.posting.scopeFilter(actor);

    return runInTransaction(this.connection, async (session) => {
      const existing = await this.load(id, scope, session);
      assertNotCancelled(existing, 'cancelled again');
      await this.post(existing, LedgerEntryKind.REVERSAL, 'cancelled', session);
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

  /** Checked lines as stored; any row error rejects the save with every row's message. */
  private async checkedLines(
    inputs: readonly LineInput[],
    exceptId: Types.ObjectId | null,
    session: ClientSession,
  ): Promise<OpeningBalanceLine[]> {
    const { lines, errors } = await this.check(inputs, exceptId, session);
    if (errors.length > 0) {
      throw new BadRequestException(errors.map((error) => `Line ${error.row}: ${error.message}`).join('; '));
    }
    return lines.map((line) => ({
      accountId: new Types.ObjectId(line.accountId!),
      debit: line.debit,
      credit: line.credit,
    }));
  }

  /**
   * Resolves each row's account (by id or code) and reports per row: unknown
   * account, system or cheque account, both or neither side filled, an
   * account twice on this voucher or already on another non-cancelled one.
   */
  private async check(
    inputs: readonly LineInput[],
    exceptId: Types.ObjectId | null,
    session?: ClientSession,
  ): Promise<{ lines: CheckedLine[]; errors: RowError[] }> {
    const [byId, byCode] = await Promise.all([
      this.ledgerAccountService.getSummaries(
        inputs.flatMap((input) => (input.accountId ? [input.accountId] : [])),
        session,
      ),
      this.ledgerAccountService.findByCodes(
        inputs.flatMap((input) => (input.accountCode ? [input.accountCode] : [])),
        session,
      ),
    ]);
    const resolve = (input: LineInput) => {
      if (input.accountCode) return byCode.get(input.accountCode.trim().toUpperCase()) ?? null;
      const summary = input.accountId ? byId.get(input.accountId) : undefined;
      return summary ? { id: input.accountId!, ...summary } : null;
    };

    const errors: RowError[] = [];
    const seen = new Set<string>();
    const lines = inputs.map((input, index): CheckedLine => {
      const row = index + 1;
      const account = resolve(input);
      const fail = (message: string) =>
        errors.push({ row, accountCode: account?.code ?? input.accountCode ?? null, message });
      const debit = round2(input.debit ?? 0);
      const credit = round2(input.credit ?? 0);

      if (!account) {
        fail(input.accountCode ? `Unknown account code "${input.accountCode}"` : `Ledger account ${input.accountId} not found`);
      } else {
        const name = `${account.code} (${account.name})`;
        if (account.systemKey) fail(`${name} is a system account and cannot take an opening balance`);
        else if (account.type === LedgerAccountType.CHEQUE) {
          fail(`${name} is a cheque account: enter pending cheques as cheque receipts`);
        } else if (!OPENING_ACCOUNT_TYPES.includes(account.type)) {
          fail(`${name} is a ${account.type} account and cannot take an opening balance`);
        }
        if (seen.has(account.id)) fail(`${name} is on more than one line`);
        seen.add(account.id);
      }
      if (debit > 0 && credit > 0) fail('Enter either a debit or a credit, not both');
      else if (!(debit > 0) && !(credit > 0)) fail('Enter a debit or a credit greater than 0');

      return {
        row,
        accountCode: account?.code ?? input.accountCode ?? null,
        accountId: account?.id ?? null,
        accountName: account?.name ?? null,
        accountType: account?.type ?? null,
        debit,
        credit,
      };
    });

    // One opening balance per account: any other non-cancelled voucher already holding it.
    const ids = [...seen];
    if (ids.length > 0) {
      const clashes = await this.model
        .find({
          status: { $ne: VoucherStatus.CANCELLED },
          'lines.accountId': { $in: ids.map((id) => new Types.ObjectId(id)) },
          ...(exceptId ? { _id: { $ne: exceptId } } : {}),
        })
        .select('voucherNo lines.accountId')
        .session(session ?? null)
        .lean()
        .exec();
      const usedOn = new Map<string, string>();
      for (const clash of clashes) {
        for (const line of clash.lines) usedOn.set(line.accountId.toString(), clash.voucherNo);
      }
      for (const line of lines) {
        const voucherNo = line.accountId ? usedOn.get(line.accountId) : undefined;
        if (voucherNo) {
          errors.push({
            row: line.row,
            accountCode: line.accountCode,
            message: `${line.accountCode} (${line.accountName}) already has an opening balance on ${voucherNo}`,
          });
        }
      }
      errors.sort((a, b) => a.row - b.row);
    }
    return { lines, errors };
  }

  /** A ledger entry per line, plus Opening Balance Equity for the difference. */
  private post(doc: OpeningBalanceDocument, kind: LedgerEntryKind, cause: string, session: ClientSession) {
    return this.posting.postEntries(
      { entityType: OPENING_BALANCE_ENTITY_TYPE, id: doc._id, voucherNo: doc.voucherNo, voucherDate: doc.asOfDate },
      [
        ...doc.lines.map((line) => ({
          accountId: line.accountId.toString(),
          debit: line.debit,
          credit: line.credit,
          narration: `Opening balance ${doc.voucherNo}`,
        })),
        {
          accountId: doc.equityAccountId.toString(),
          debit: doc.equityDebit,
          credit: doc.equityCredit,
          narration: `Opening balance difference ${doc.voucherNo}`,
        },
      ],
      kind,
      cause,
      session,
    );
  }

  /** Field diff for the audit: date, comments, and each account's Dr/Cr amount. */
  private async diff(
    before: OpeningBalanceDocument,
    after: { asOfDate: Date; comments?: string; lines: readonly OpeningBalanceLine[] },
    session: ClientSession,
  ): Promise<AuditChange[]> {
    const changes: AuditChange[] = [];
    const day = (date: Date) => date.toISOString().slice(0, 10);
    if (day(before.asOfDate) !== day(after.asOfDate)) {
      changes.push({ field: 'asOfDate', label: 'As of', from: day(before.asOfDate), to: day(after.asOfDate) });
    }
    if ((before.comments ?? '') !== (after.comments ?? '')) {
      changes.push({ field: 'comments', label: 'Comments', from: before.comments ?? null, to: after.comments ?? null });
    }
    const side = (lines: readonly OpeningBalanceLine[]) =>
      new Map(
        lines.map((line) => [
          line.accountId.toString(),
          line.debit > 0 ? `Dr ${line.debit.toFixed(2)}` : `Cr ${line.credit.toFixed(2)}`,
        ]),
      );
    const from = side(before.lines);
    const to = side(after.lines);
    const accountIds = [...new Set([...from.keys(), ...to.keys()])].filter((id) => from.get(id) !== to.get(id));
    const names = await this.ledgerAccountService.getNames(accountIds, session);
    for (const accountId of accountIds) {
      changes.push({
        field: 'lines',
        label: names.get(accountId) ?? accountId,
        from: from.get(accountId) ?? null,
        to: to.get(accountId) ?? null,
      });
    }
    return changes;
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
    doc: OpeningBalanceDocument,
    action: AuditAction,
    actor: Actor,
    at: Date,
    session: ClientSession,
    extra: { changes?: AuditChange[]; reason?: string } = {},
  ) {
    return this.auditService.record(
      { entityType: OPENING_BALANCE_ENTITY_TYPE, entityId: doc._id, entityRef: doc.voucherNo, action, actor, at, ...extra },
      session,
    );
  }
}

/** Totals and the balancing equity entry: debits short of credits are debited to equity, the excess credited. */
function totalsOf(lines: readonly { debit: number; credit: number }[]) {
  const totalDebit = sum2(lines.map((line) => line.debit));
  const totalCredit = sum2(lines.map((line) => line.credit));
  const difference = round2(totalDebit - totalCredit);
  return {
    totalDebit,
    totalCredit,
    equityDebit: difference < 0 ? -difference : 0,
    equityCredit: difference > 0 ? difference : 0,
  };
}

/** Today is taken in Asia/Dubai (UTC+4, no DST). */
function assertNotFuture(asOfDate: string): void {
  const today = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (asOfDate.slice(0, 10) > today) {
    throw new BadRequestException('The as-of date cannot be in the future');
  }
}

function assertNotCancelled(doc: OpeningBalanceDocument, action: string): void {
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
