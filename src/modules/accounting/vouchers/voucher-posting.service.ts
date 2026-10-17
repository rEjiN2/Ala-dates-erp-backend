import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model, QueryFilter, SortOrder } from 'mongoose';
import {
  PaymentMethod,
  VoucherDocument,
  VoucherLine,
  VoucherStatus,
  paymentMethodFor,
} from './schemas/voucher.schema.js';
import { LedgerEntry, LedgerEntryDocument, LedgerEntryKind } from './schemas/ledger-entry.schema.js';
import { VoucherDirection, type VoucherDefinition } from './voucher-definition.js';
import { diffVoucher, type DiffableVoucher } from './voucher-diff.js';
import { CANCEL_REASON_MIN_LENGTH, type VoucherQueryDto } from './dto/voucher.dto.js';
import { LedgerAccountService } from '../ledger-accounts/ledger-account.service.js';
import { LedgerAccountUsageRegistry } from '../ledger-accounts/ledger-account-usage.registry.js';
import { LedgerAccountType } from '../ledger-accounts/schemas/ledger-account.schema.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { escapeRegExp } from '../../sequence/code-sequence.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction, type AuditChange } from '../../audit/schemas/audit-log.schema.js';
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
import { hasPermission } from '../../roles/permissions.js';
import {
  type LinkedCashier,
  type ScopedUser,
  assertScopedHeaderAccount,
  isOwnScope,
  resolveScopedCashier,
  voucherScopeFilter,
  withScope,
} from './data-scope.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';

export type VoucherModel = Model<VoucherDocument>;

export interface VoucherLineInput {
  accountId: string;
  narration?: string;
  remarks?: string;
  amount: number;
  vat?: number;
}

/** A voucher's create body, with its header account under a common name. */
export interface VoucherCreateInput {
  voucherDate: string;
  headerAccountId: string;
  /** Required unless the user is "own"-scoped: their linked cashier is then used. */
  cashierId?: string;
  paymentReference?: string | null;
  comments?: string;
  lines: VoucherLineInput[];
  acknowledgeWarnings?: boolean;
  /** Voucher-specific document fields, already validated by the voucher's own service. */
  extraFields?: Record<string, unknown>;
}

export interface VoucherUpdateInput {
  voucherDate?: string;
  headerAccountId?: string;
  cashierId?: string | null;
  paymentReference?: string | null;
  comments?: string;
  lines?: VoucherLineInput[];
  changeNote?: string;
  acknowledgeWarnings?: boolean;
  /** Voucher-specific fields to set, and their audit changes (they count towards "no changes"). */
  extraFields?: Record<string, unknown>;
  extraChanges?: AuditChange[];
}

export interface VoucherListQuery extends Omit<VoucherQueryDto, never> {
  headerAccountId?: string;
}

type UserRef = { id: string; name: string } | null;

export interface VoucherListRow {
  id: string;
  voucherNo: string;
  date: Date;
  /** The header (cash/wallet/bank) account; each voucher renames this key in its own rows. */
  header: { id: string; name: string | null };
  /** id is null on vouchers from before the cashier master; name is their old free text. */
  cashier: { id: string | null; name: string | null };
  paymentMethod: PaymentMethod;
  /** First line's account, plus how many other distinct accounts the voucher touches. */
  partiesSummary: { firstAccount: { id: string; name: string | null } | null; othersCount: number };
  grandTotal: number;
  status: VoucherStatus;
  /** null on vouchers created before audit tracking: show as unknown. */
  createdBy: UserRef;
  createdAt: Date | null;
  updatedBy: UserRef;
  updatedAt: Date | null;
  commentCount: number;
}

export interface VoucherPage<Row> {
  items: Row[];
  page: number;
  pageSize: number;
  /** count: every voucher matching the filter; total: their grand totals, cancelled ones excluded. */
  summary: { count: number; total: number };
}

/** Something the user must confirm before the voucher is saved. */
export interface VoucherWarning {
  code: 'NEGATIVE_BALANCE';
  accountId: string;
  accountCode: string;
  accountName: string;
  balanceBefore: number;
  balanceAfter: number;
  message: string;
}

/**
 * 409 carrying the warnings. Nothing was saved (the transaction aborted);
 * resend with acknowledgeWarnings: true to save anyway.
 */
export class VoucherWarningsException extends HttpException {
  constructor(readonly warnings: VoucherWarning[]) {
    super(
      {
        message: `${warnings.map((warning) => warning.message).join(' ')} Resend with acknowledgeWarnings: true to save anyway.`,
        warnings,
      },
      HttpStatus.CONFLICT,
    );
  }
}

interface PricedLine {
  accountId: string;
  narration?: string;
  remarks?: string;
  amount: number;
  vat: number;
  netAmount: number;
}

/** What a voucher posts: its header account against each line. */
interface Posting {
  voucherId: Types.ObjectId;
  voucherNo: string;
  voucherDate: Date;
  headerAccountId: string;
  lines: readonly Pick<VoucherLine, 'accountId' | 'netAmount' | 'narration'>[];
}

/** Watched cash/wallet accounts and their balance before the voucher's changes. */
type BalanceWatch = Map<string, { code: string; name: string; before: number }>;

const SORT_FIELDS: Record<NonNullable<VoucherQueryDto['sortBy']>, string[]> = {
  date: ['voucherDate', 'voucherNo'],
  amount: ['grandTotal', 'voucherNo'],
  voucherNo: ['voucherNo'],
};

const OVERDRAW_WATCHED_TYPES: readonly LedgerAccountType[] = [LedgerAccountType.CASH, LedgerAccountType.WALLET];

/**
 * The shared engine behind cash/bank vouchers (receipts, payments, ...).
 * Everything that touches money happens in one transaction per call: the
 * voucher number, the document, the ledger entries, the balance updates and
 * the audit entry are all committed together or not at all.
 *
 * Ledger convention: balance = sum(debit - credit). An edit or cancel writes
 * reversing entries, never changes old ones.
 */
@Injectable()
export class VoucherPostingService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(LedgerEntry.name) private readonly entryModel: Model<LedgerEntryDocument>,
    private readonly ledgerAccountService: LedgerAccountService,
    private readonly sequenceService: SequenceService,
    private readonly auditService: AuditService,
    private readonly commentsService: CommentsService,
    private readonly cashierService: CashierService,
    private readonly ledgerUsage: LedgerAccountUsageRegistry,
    private readonly cashierUsage: CashierUsageRegistry,
    private readonly entityAccess: EntityAccessRegistry,
  ) {
    // An account with ledger history can't be deleted, even if the voucher that
    // wrote it is gone: the entries would be left pointing at nothing.
    ledgerUsage.register('ledger entries', async (accountId, session) =>
      Boolean(
        await this.entryModel
          .exists({ accountId })
          .session(session ?? null)
          .exec(),
      ),
    );
  }

  /** Hooks a voucher type into usage checks (accounts, cashiers) and comments/activity. Call once, from its service. */
  registerVoucherType(def: VoucherDefinition, model: VoucherModel): void {
    this.ledgerUsage.register(def.usageSource, async (accountId, session) =>
      Boolean(
        await model
          .exists({ $or: [{ [def.headerField]: accountId }, { 'lines.accountId': accountId }] })
          .session(session ?? null)
          .exec(),
      ),
    );
    this.cashierUsage.register(def.usageSource, async (cashierId, session) =>
      Boolean(
        await model
          .exists({ cashierId })
          .session(session ?? null)
          .exec(),
      ),
    );
    // Comments and activity follow the voucher's GET routes: the read
    // permission, and for "own"-scoped users only their own vouchers.
    this.entityAccess.register(def.entityType, {
      exists: async (id, user) =>
        Boolean(await model.exists(withScope({ _id: id }, await this.scopeFilter(user, def))).exec()),
      canRead: (user) => hasPermission(user, def.readPermission),
    });
  }

  /** Mongo filter limiting `user` to the vouchers they may see; null when they see all. */
  async scopeFilter(user: ScopedUser | undefined, def?: VoucherDefinition): Promise<Record<string, unknown> | null> {
    if (!isOwnScope(user)) {
      return null;
    }
    return voucherScopeFilter(user, await this.linkedCashierOf(user), def?.scopeRule);
  }

  private async linkedCashierOf(user: ScopedUser): Promise<LinkedCashier | null> {
    const cashier = await this.cashierService.findByLinkedUser(user.id);
    return cashier ? { id: cashier.id as string, code: cashier.code, name: cashier.name } : null;
  }

  async list(
    def: VoucherDefinition,
    model: VoucherModel,
    query: VoucherListQuery,
    viewer?: ScopedUser,
    extraFilter: Record<string, unknown> | null = null,
  ): Promise<VoucherPage<VoucherListRow>> {
    const filter = withScope(withScope(this.listFilter(def, query), extraFilter), await this.scopeFilter(viewer, def));
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const direction: SortOrder = query.sortDir === 'asc' ? 1 : -1;
    const sort = Object.fromEntries(SORT_FIELDS[query.sortBy ?? 'date'].map((field) => [field, direction]));

    const [vouchers, summaryRows] = await Promise.all([
      model
        .find(filter)
        .sort(sort)
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean<(Record<string, unknown> & VoucherDocument)[]>()
        .exec(),
      // $match doesn't cast, so listFilter builds ObjectIds and Dates itself.
      model
        .aggregate<{ count: number; total: number }>([
          { $match: filter },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              total: { $sum: { $cond: [{ $eq: ['$status', VoucherStatus.CANCELLED] }, 0, '$grandTotal'] } },
            },
          },
        ])
        .exec(),
    ]);

    const headerOf = (voucher: Record<string, unknown>) => (voucher[def.headerField] as Types.ObjectId).toString();
    const [names, commentCounts] = await Promise.all([
      this.ledgerAccountService.getNames(
        vouchers.flatMap((voucher) => [
          headerOf(voucher),
          ...(voucher.lines[0] ? [voucher.lines[0].accountId.toString()] : []),
        ]),
      ),
      this.commentsService.countByEntityIds(
        def.entityType,
        vouchers.map((voucher) => voucher._id),
      ),
    ]);

    return {
      items: vouchers.map((voucher) => {
        const headerId = headerOf(voucher);
        const firstAccountId = voucher.lines[0]?.accountId.toString();
        const distinctAccounts = new Set(voucher.lines.map((line) => line.accountId.toString())).size;
        return {
          id: voucher._id.toString(),
          voucherNo: voucher.voucherNo,
          date: voucher.voucherDate,
          header: { id: headerId, name: names.get(headerId) ?? null },
          cashier: { id: voucher.cashierId?.toString() ?? null, name: voucher.cashierName ?? null },
          paymentMethod: voucher.paymentMethod ?? PaymentMethod.CASH,
          partiesSummary: {
            firstAccount: firstAccountId ? { id: firstAccountId, name: names.get(firstAccountId) ?? null } : null,
            othersCount: Math.max(distinctAccounts - 1, 0),
          },
          grandTotal: voucher.grandTotal,
          status: voucher.status ?? VoucherStatus.POSTED,
          createdBy: userRefOf(voucher.createdBy as UserSnapshot | null | undefined),
          createdAt: voucher.createdAt ?? null,
          updatedBy: userRefOf(voucher.updatedBy as UserSnapshot | null | undefined),
          updatedAt: voucher.updatedAt ?? null,
          commentCount: commentCounts.get(voucher._id.toString()) ?? 0,
        };
      }),
      page,
      pageSize,
      summary: { count: summaryRows[0]?.count ?? 0, total: round2(summaryRows[0]?.total ?? 0) },
    };
  }

  /** A voucher outside the viewer's data scope is reported as not found. */
  async findById(def: VoucherDefinition, model: VoucherModel, id: string, viewer?: ScopedUser): Promise<VoucherDocument> {
    this.assertValidId(def, id);
    const voucher = await model
      .findOne(withScope({ _id: new Types.ObjectId(id) }, await this.scopeFilter(viewer, def)))
      .exec();
    if (!voucher) {
      throw new NotFoundException(`${def.label} ${id} not found`);
    }
    return voucher;
  }

  /**
   * `actor` is the authenticated user; nothing in the input can set who
   * created the voucher. An "own"-scoped actor posts only for their linked
   * cashier and into one of their allowed cash accounts (403 otherwise).
   */
  async create(
    def: VoucherDefinition,
    model: VoucherModel,
    input: VoucherCreateInput,
    actor: Actor & ScopedUser,
  ): Promise<VoucherDocument> {
    let cashierId = input.cashierId;
    if (isOwnScope(actor)) {
      cashierId = resolveScopedCashier(await this.linkedCashierOf(actor), input.cashierId, def.label);
      assertScopedHeaderAccount(actor, input.headerAccountId, def.label);
    }
    if (!cashierId) {
      throw new BadRequestException('cashierId is required');
    }
    const headerAccount = await this.ledgerAccountService.findActiveReceiptAccount(input.headerAccountId);
    const pricedLines = this.priceLines(input.lines);
    this.assertHeaderNotOnLines(def, input.headerAccountId, pricedLines);

    return runInTransaction(this.connection, async (session) => {
      await this.assertLineAccountTypes(def, pricedLines, session);
      const cashier = await this.cashierService.findActiveForPosting(cashierId, session);
      const watch = await this.watchBalances(def, [input.headerAccountId], session);
      const lines = await this.snapshotLines(pricedLines, session);
      // Issued on the transaction's session: if anything below aborts, the
      // counter increment rolls back too, so voucher numbers stay gapless.
      const voucherNo = await this.sequenceService.nextCode(def.sequence, session);
      const now = new Date();

      const [created] = await model.create(
        [
          {
            voucherNo,
            voucherDate: new Date(input.voucherDate),
            [def.headerField]: new Types.ObjectId(input.headerAccountId),
            cashierId: cashier._id,
            cashierName: cashier.name,
            paymentMethod: paymentMethodFor(headerAccount.type),
            paymentReference: input.paymentReference ?? null,
            comments: input.comments,
            lines,
            ...this.totalsOf(pricedLines),
            status: VoucherStatus.POSTED,
            createdBy: toUserSnapshot(actor),
            createdAt: now,
            ...input.extraFields,
          },
        ],
        { session },
      );

      await this.post(def, this.postingOf(def, created), 'created', session);
      await this.assertWarningsAcknowledged(def, watch, input.acknowledgeWarnings, session);

      await this.auditService.record(
        {
          entityType: def.entityType,
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
   * Edit by reversal: the old posting is reversed and the new one posted, in
   * one transaction. Rejects with "No changes to save" when the edit changes
   * nothing visible; the transaction then aborts, so neither updatedAt, the
   * ledger nor the audit log moves.
   *
   * Cashier: keeping the voucher's current cashier is allowed even if it has
   * since been deactivated; switching to another needs an active one. A
   * voucher from before the cashier master must be given one to be saved.
   */
  async update(
    def: VoucherDefinition,
    model: VoucherModel,
    id: string,
    input: VoucherUpdateInput,
    actor: Actor & ScopedUser,
  ): Promise<VoucherDocument> {
    const current = await this.findById(def, model, id, actor);
    this.assertNotCancelled(def, current, 'edited');

    const currentHeaderId = this.headerOf(def, current).toString();
    const nextHeaderId = input.headerAccountId ?? currentHeaderId;
    if (isOwnScope(actor)) {
      // Keeping what the voucher already has is fine; changing it follows the create rules.
      if (input.cashierId && input.cashierId !== current.cashierId?.toString()) {
        resolveScopedCashier(await this.linkedCashierOf(actor), input.cashierId, def.label);
      }
      if (nextHeaderId !== currentHeaderId) {
        assertScopedHeaderAccount(actor, nextHeaderId, def.label);
      }
    }
    const headerAccount = await this.ledgerAccountService.findActiveReceiptAccount(nextHeaderId);
    const pricedLines = input.lines ? this.priceLines(input.lines) : null;

    return runInTransaction(this.connection, async (session) => {
      // Re-read on the session: the diff, the reversal and the save must all
      // describe the same version of the voucher.
      const existing = await model.findById(id).session(session).exec();
      if (!existing) {
        throw new NotFoundException(`${def.label} ${id} not found`);
      }
      this.assertNotCancelled(def, existing, 'edited');

      if (input.cashierId === null) {
        throw new BadRequestException(`A ${def.label.toLowerCase()} must have a cashier`);
      }
      let nextCashierId = existing.cashierId?.toString() ?? null;
      let nextCashierName = existing.cashierName;
      if (input.cashierId !== undefined && input.cashierId !== nextCashierId) {
        const cashier = await this.cashierService.findActiveForPosting(input.cashierId, session);
        nextCashierId = cashier._id.toString();
        nextCashierName = cashier.name;
      }
      if (!nextCashierId) {
        throw new BadRequestException(
          `${def.label} ${existing.voucherNo} was entered before cashiers were set up: choose a cashier (cashierId) to save changes`,
        );
      }

      const before = this.diffable(def, existing);
      const after: DiffableVoucher = {
        voucherDate: input.voucherDate !== undefined ? new Date(input.voucherDate) : existing.voucherDate,
        headerAccountId: nextHeaderId,
        cashierId: nextCashierId,
        cashierName: nextCashierName,
        paymentReference: input.paymentReference !== undefined ? input.paymentReference : existing.paymentReference,
        comments: input.comments !== undefined ? input.comments : existing.comments,
        lines: pricedLines ?? before.lines,
      };
      this.assertHeaderNotOnLines(def, after.headerAccountId, after.lines);
      // Only lines sent with this edit are checked: lines already on an older
      // voucher are kept as they were posted.
      if (pricedLines) {
        await this.assertLineAccountTypes(def, pricedLines, session);
      }
      const names = await this.ledgerAccountService.getNames(
        [before, after].flatMap((version) => [version.headerAccountId, ...version.lines.map((line) => line.accountId)]),
        session,
      );
      const changes = [
        ...diffVoucher(before, after, names, def.headerLabel, def.cashierLabel),
        ...(input.extraChanges ?? []),
      ];
      if (changes.length === 0) {
        throw new BadRequestException('No changes to save');
      }

      const watch = await this.watchBalances(def, [currentHeaderId, nextHeaderId], session);
      // Unwind the original posting first, so a replacement line's oldBalance
      // snapshot reflects the balance as if this voucher had never been posted.
      await this.reverse(def, this.postingOf(def, existing), 'updated', session);

      const nextLines = pricedLines ? await this.snapshotLines(pricedLines, session) : existing.lines;
      const now = new Date();

      existing.voucherDate = after.voucherDate;
      existing.cashierId = new Types.ObjectId(nextCashierId);
      existing.cashierName = nextCashierName;
      existing.paymentMethod = paymentMethodFor(headerAccount.type);
      existing.paymentReference = after.paymentReference ?? null;
      if (input.comments !== undefined) existing.comments = input.comments;
      existing.set(def.headerField, new Types.ObjectId(nextHeaderId));
      existing.lines = nextLines;
      if (input.extraFields) existing.set(input.extraFields);

      const totals = this.totalsOf(nextLines);
      existing.grossTotal = totals.grossTotal;
      existing.totalTax = totals.totalTax;
      existing.grandTotal = totals.grandTotal;
      existing.updatedBy = toUserSnapshot(actor);
      existing.updatedAt = now;

      await existing.save({ session });
      await this.post(def, this.postingOf(def, existing), 'updated', session);
      await this.assertWarningsAcknowledged(def, watch, input.acknowledgeWarnings, session);

      await this.auditService.record(
        {
          entityType: def.entityType,
          entityId: existing._id,
          entityRef: existing.voucherNo,
          action: AuditAction.UPDATED,
          actor,
          changes,
          reason: input.changeNote,
          at: now,
        },
        session,
      );
      return existing;
    });
  }

  /** Reverses the posting and keeps the voucher, marked cancelled, with who/when/why. */
  async cancel(
    def: VoucherDefinition,
    model: VoucherModel,
    id: string,
    rawReason: unknown,
    actor: Actor & ScopedUser,
  ): Promise<VoucherDocument> {
    this.assertValidId(def, id);
    const scope = await this.scopeFilter(actor, def);
    const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
    if (reason.length < CANCEL_REASON_MIN_LENGTH) {
      throw new BadRequestException(
        `A cancellation reason of at least ${CANCEL_REASON_MIN_LENGTH} characters is required`,
      );
    }

    return runInTransaction(this.connection, async (session) => {
      const existing = await model
        .findOne(withScope({ _id: new Types.ObjectId(id) }, scope))
        .session(session)
        .exec();
      if (!existing) {
        throw new NotFoundException(`${def.label} ${id} not found`);
      }
      this.assertNotCancelled(def, existing, 'cancelled again');

      await this.reverse(def, this.postingOf(def, existing), 'cancelled', session);

      const now = new Date();
      existing.status = VoucherStatus.CANCELLED;
      existing.cancelledBy = toUserSnapshot(actor);
      existing.cancelledAt = now;
      existing.cancelReason = reason;
      await existing.save({ session });

      await this.auditService.record(
        {
          entityType: def.entityType,
          entityId: existing._id,
          entityRef: existing.voucherNo,
          action: AuditAction.CANCELLED,
          actor,
          changes: [{ field: 'status', label: 'Status', from: VoucherStatus.POSTED, to: VoucherStatus.CANCELLED }],
          reason,
          at: now,
        },
        session,
      );
      return existing;
    });
  }

  /** Hard delete, reversing the posting first unless a cancel already did. */
  async remove(
    def: VoucherDefinition,
    model: VoucherModel,
    id: string,
    viewer?: ScopedUser,
  ): Promise<{ success: true }> {
    const existing = await this.findById(def, model, id, viewer);

    return runInTransaction(this.connection, async (session) => {
      if (existing.status !== VoucherStatus.CANCELLED) {
        await this.reverse(def, this.postingOf(def, existing), 'deleted', session);
      }
      await model.deleteOne({ _id: existing._id }, { session }).exec();
      return { success: true as const };
    });
  }

  /** Line amounts rounded to 2dp and totalled server-side; any client-sent total is never read. */
  priceLines(lines: readonly VoucherLineInput[]): PricedLine[] {
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

  totalsOf(lines: readonly Pick<PricedLine, 'amount' | 'vat' | 'netAmount'>[]) {
    return {
      grossTotal: sum2(lines.map((line) => line.amount)),
      totalTax: sum2(lines.map((line) => line.vat)),
      grandTotal: sum2(lines.map((line) => line.netAmount)),
    };
  }

  /** Writes the voucher's ledger entries and moves the balances. */
  private async post(def: VoucherDefinition, posting: Posting, cause: string, session: ClientSession): Promise<void> {
    await this.writeEntries(def, posting, LedgerEntryKind.POSTING, cause, session);
  }

  /** Writes entries that exactly undo `posting`, and moves the balances back. */
  private async reverse(
    def: VoucherDefinition,
    posting: Posting,
    cause: string,
    session: ClientSession,
  ): Promise<void> {
    await this.writeEntries(def, posting, LedgerEntryKind.REVERSAL, cause, session);
  }

  private async writeEntries(
    def: VoucherDefinition,
    posting: Posting,
    kind: LedgerEntryKind,
    cause: string,
    session: ClientSession,
  ): Promise<void> {
    // Receipt: header debit, lines credit. Payment: the other way round.
    // A reversal swaps the sides of the posting it undoes.
    const headerIsDebit = (def.direction === VoucherDirection.RECEIPT) === (kind === LedgerEntryKind.POSTING);
    const side = (amount: number, debit: boolean) => ({ debit: debit ? amount : 0, credit: debit ? 0 : amount });
    const postedAt = new Date();
    const common = {
      voucherType: def.entityType,
      voucherId: posting.voucherId,
      voucherNo: posting.voucherNo,
      voucherDate: posting.voucherDate,
      kind,
      cause,
      postedAt,
    };

    const grandTotal = sum2(posting.lines.map((line) => line.netAmount));
    const rows = [
      {
        ...common,
        accountId: new Types.ObjectId(posting.headerAccountId),
        narration: posting.voucherNo,
        ...side(grandTotal, headerIsDebit),
      },
      ...posting.lines.map((line) => ({
        ...common,
        accountId: new Types.ObjectId(line.accountId.toString()),
        narration: line.narration ?? null,
        ...side(round2(line.netAmount), !headerIsDebit),
      })),
    ].filter((row) => row.debit > 0 || row.credit > 0);

    await this.entryModel.insertMany(rows, { session });

    const deltas = new Map<string, number>();
    for (const row of rows) {
      const accountId = row.accountId.toString();
      deltas.set(accountId, round2((deltas.get(accountId) ?? 0) + row.debit - row.credit));
    }
    // An unknown account id throws here, aborting the whole voucher.
    await this.ledgerAccountService.applyBalanceDeltas(deltas, session);
  }

  /** Balances of the cash/wallet accounts among `accountIds`, before the voucher touches them. */
  private async watchBalances(
    def: VoucherDefinition,
    accountIds: readonly string[],
    session: ClientSession,
  ): Promise<BalanceWatch | null> {
    if (!def.warnOnOverdraw) {
      return null;
    }
    const ids = [...new Set(accountIds)];
    const [summaries, balances] = await Promise.all([
      this.ledgerAccountService.getSummaries(ids, session),
      this.ledgerAccountService.getBalances(ids, session),
    ]);
    const watch: BalanceWatch = new Map();
    for (const [id, summary] of summaries) {
      if (OVERDRAW_WATCHED_TYPES.includes(summary.type)) {
        watch.set(id, { code: summary.code, name: summary.name, before: balances.get(id) ?? 0 });
      }
    }
    return watch;
  }

  /**
   * After posting: any watched account this voucher took (further) below
   * zero is a warning. Unless acknowledged, throwing here aborts the
   * transaction, so nothing is saved and no number is used.
   */
  private async assertWarningsAcknowledged(
    def: VoucherDefinition,
    watch: BalanceWatch | null,
    acknowledged: boolean | undefined,
    session: ClientSession,
  ): Promise<void> {
    if (!watch || watch.size === 0) {
      return;
    }
    const after = await this.ledgerAccountService.getBalances([...watch.keys()], session);
    const warnings: VoucherWarning[] = [];
    for (const [accountId, account] of watch) {
      const balanceAfter = round2(after.get(accountId) ?? 0);
      const balanceBefore = round2(account.before);
      if (balanceAfter < 0 && balanceAfter < balanceBefore) {
        warnings.push({
          code: 'NEGATIVE_BALANCE',
          accountId,
          accountCode: account.code,
          accountName: account.name,
          balanceBefore,
          balanceAfter,
          message: `This ${def.label.toLowerCase()} takes ${account.name} (${account.code}) below zero: ${balanceBefore.toFixed(2)} becomes ${balanceAfter.toFixed(2)}.`,
        });
      }
    }
    if (warnings.length > 0 && acknowledged !== true) {
      throw new VoucherWarningsException(warnings);
    }
  }

  private async snapshotLines(pricedLines: readonly PricedLine[], session: ClientSession): Promise<VoucherLine[]> {
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

  /** Every line account must exist and be of a type this voucher allows. */
  private async assertLineAccountTypes(
    def: VoucherDefinition,
    lines: readonly { accountId: string }[],
    session: ClientSession,
  ): Promise<void> {
    const accounts = await this.ledgerAccountService.getSummaries(
      lines.map((line) => line.accountId),
      session,
    );
    lines.forEach((line, index) => {
      const account = accounts.get(line.accountId);
      if (!account) {
        throw new NotFoundException(`Line ${index + 1}: ledger account ${line.accountId} not found`);
      }
      if (!def.lineAccountTypes.includes(account.type)) {
        throw new BadRequestException(
          `Line ${index + 1}: ${account.code} (${account.name}) is a ${account.type} account. ${def.lineTypeHint}`,
        );
      }
    });
  }

  /** The header account can't also be one of the line accounts. */
  private assertHeaderNotOnLines(
    def: VoucherDefinition,
    headerAccountId: string,
    lines: readonly { accountId: string }[],
  ): void {
    if (lines.some((line) => line.accountId === headerAccountId)) {
      throw new BadRequestException(`The "${def.headerLabel.toLowerCase()}" account cannot also be used on a line`);
    }
  }

  private listFilter(def: VoucherDefinition, query: VoucherListQuery): QueryFilter<VoucherDocument> {
    const filter: Record<string, unknown> = {};

    if (query.dateFrom || query.dateTo) {
      const range: { $gte?: Date; $lte?: Date } = {};
      if (query.dateFrom) range.$gte = new Date(query.dateFrom);
      if (query.dateTo) range.$lte = this.endOfDayIfDateOnly(query.dateTo);
      if (range.$gte && range.$lte && range.$gte > range.$lte) {
        throw new BadRequestException('dateFrom must not be after dateTo');
      }
      filter.voucherDate = range;
    }

    // Vouchers from before cancellation existed have no status and count as posted.
    if (query.status === 'posted') {
      filter.status = { $ne: VoucherStatus.CANCELLED };
    } else if (query.status === 'cancelled') {
      filter.status = VoucherStatus.CANCELLED;
    }

    if (query.headerAccountId) filter[def.headerField] = new Types.ObjectId(query.headerAccountId);
    if (query.accountId) filter['lines.accountId'] = new Types.ObjectId(query.accountId);
    if (query.cashierId) filter.cashierId = new Types.ObjectId(query.cashierId);
    if (query.paymentMethod === PaymentMethod.BANK) {
      filter.paymentMethod = PaymentMethod.BANK;
    } else if (query.paymentMethod === PaymentMethod.CASH) {
      // Vouchers from before bank support have no method and count as cash.
      filter.paymentMethod = { $ne: PaymentMethod.BANK };
    }
    if (query.createdBy) filter['createdBy.id'] = new Types.ObjectId(query.createdBy);

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

    return filter as QueryFilter<VoucherDocument>;
  }

  private headerOf(def: VoucherDefinition, voucher: VoucherDocument): Types.ObjectId {
    return voucher.get(def.headerField) as Types.ObjectId;
  }

  private postingOf(def: VoucherDefinition, voucher: VoucherDocument): Posting {
    return {
      voucherId: voucher._id,
      voucherNo: voucher.voucherNo,
      voucherDate: voucher.voucherDate,
      headerAccountId: this.headerOf(def, voucher).toString(),
      lines: voucher.lines,
    };
  }

  private diffable(def: VoucherDefinition, voucher: VoucherDocument): DiffableVoucher {
    return {
      voucherDate: voucher.voucherDate,
      headerAccountId: this.headerOf(def, voucher).toString(),
      cashierId: voucher.cashierId?.toString() ?? null,
      cashierName: voucher.cashierName,
      paymentReference: voucher.paymentReference,
      comments: voucher.comments,
      lines: voucher.lines.map((line) => ({
        accountId: line.accountId.toString(),
        amount: line.amount,
        vat: line.vat,
        narration: line.narration,
        remarks: line.remarks,
      })),
    };
  }

  private assertValidId(def: VoucherDefinition, id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`${def.label} id "${id}" is not a valid id`);
    }
  }

  private assertNotCancelled(def: VoucherDefinition, voucher: VoucherDocument, action: string): void {
    if (voucher.status === VoucherStatus.CANCELLED) {
      throw new BadRequestException(`${def.label} ${voucher.voucherNo} is cancelled and cannot be ${action}`);
    }
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
