import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model, SortOrder } from 'mongoose';
import { CashHandover, CashHandoverDocument, type HandoverLine } from './schemas/cash-handover.schema.js';
import {
  ApproveCashHandoverDto,
  CancelCashHandoverDto,
  CashHandoverQueryDto,
  CreateCashHandoverDto,
  PendingQueryDto,
  RejectCashHandoverDto,
} from './dto/cash-handover.dto.js';
import { CASH_HANDOVER_DEFINITION } from './cash-handover.definition.js';
import { VoucherPostingService, type VoucherModel, type VoucherPage } from '../vouchers/voucher-posting.service.js';
import { VoucherPrintService, type PrintedVoucher } from '../vouchers/voucher-print.service.js';
import { isOwnScope, resolveCollectorId, withScope, type ScopedUser } from '../vouchers/data-scope.js';
import { VoucherStatus } from '../vouchers/schemas/voucher.schema.js';
import { LedgerEntryKind } from '../vouchers/schemas/ledger-entry.schema.js';
import { CASH_LIKE_ACCOUNT_TYPES, LedgerAccountService } from '../ledger-accounts/ledger-account.service.js';
import { LedgerAccountUsageRegistry } from '../ledger-accounts/ledger-account-usage.registry.js';
import { LedgerAccountType } from '../ledger-accounts/schemas/ledger-account.schema.js';
import { UsersService } from '../../users/users.service.js';
import type { UserDocument } from '../../users/schemas/user.schema.js';
import { CompanyService } from '../../company/company.service.js';
import { CommentsService } from '../../comments/comments.service.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction, type AuditChange } from '../../audit/schemas/audit-log.schema.js';
import { Permission, hasPermission } from '../../roles/permissions.js';
import { type Actor, toUserSnapshot, userRefOf } from '../../../common/schemas/user-snapshot.schema.js';
import { round2, sum2 } from '../../../common/utils/money.util.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';

/** The authenticated user; "own"-scoped users see only their own handovers. */
type Viewer = Actor & ScopedUser;

type Ref = { id: string; name: string | null };

const DEF = CASH_HANDOVER_DEFINITION;

/** Where each source type's money may be received. */
const RECEIVE_INTO_TYPES: readonly LedgerAccountType[] = [
  LedgerAccountType.CASH,
  LedgerAccountType.WALLET,
  LedgerAccountType.CHEQUE,
  LedgerAccountType.BANK,
];

export interface PendingAccount {
  accountId: string;
  code: string;
  name: string;
  type: LedgerAccountType;
  /** The account's current balance: everything the user holds in it. */
  balance: number;
  /** Already on their submitted (not yet approved) handovers. */
  submitted: number;
  /** balance - submitted: what a new handover may still include. */
  available: number;
}

export interface PendingCash {
  user: Ref;
  accounts: PendingAccount[];
  totals: { balance: number; submitted: number; available: number };
}

export interface CashHandoverListRow {
  id: string;
  voucherNo: string;
  date: Date;
  user: Ref;
  status: VoucherStatus;
  submittedTotal: number;
  receivedTotal: number | null;
  itemCount: number;
  createdBy: { id: string; name: string } | null;
  createdAt: Date | null;
  commentCount: number;
}

/**
 * Balance-based cash handover: a user's pending money is the balance of
 * their own cash, wallet and cheque accounts (allowedCashAccountIds). Submit
 * records amounts and posts nothing; approve moves the received amounts from
 * each source into the receiving account in one transaction (short leaves
 * the rest in the source); reject posts nothing; cancelling an approved one
 * reverses it. Every step is one transaction with its audit entry.
 */
@Injectable()
export class CashHandoverService {
  private readonly model: VoucherModel;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(CashHandover.name) private readonly handoverModel: Model<CashHandoverDocument>,
    private readonly posting: VoucherPostingService,
    private readonly printService: VoucherPrintService,
    private readonly ledgerAccountService: LedgerAccountService,
    private readonly usersService: UsersService,
    private readonly companyService: CompanyService,
    private readonly commentsService: CommentsService,
    private readonly sequenceService: SequenceService,
    private readonly auditService: AuditService,
    ledgerUsage: LedgerAccountUsageRegistry,
  ) {
    this.model = handoverModel as unknown as VoucherModel;
    posting.registerVoucherType(DEF, this.model);
    ledgerUsage.register('cash handovers (received into)', async (accountId, session) =>
      Boolean(
        await this.handoverModel
          .exists({ 'items.receivedIntoAccountId': accountId })
          .session(session ?? null)
          .exec(),
      ),
    );
  }

  async findAll(query: CashHandoverQueryDto = {}, viewer?: Viewer): Promise<VoucherPage<CashHandoverListRow>> {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.userId) filter.collectedById = new Types.ObjectId(query.userId);
    if (query.dateFrom || query.dateTo) {
      const range: { $gte?: Date; $lte?: Date } = {};
      if (query.dateFrom) range.$gte = new Date(query.dateFrom);
      if (query.dateTo) range.$lte = endOfDayIfDateOnly(query.dateTo);
      filter.voucherDate = range;
    }
    const scoped = withScope(filter, await this.posting.scopeFilter(viewer, DEF));
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const sort: Record<string, SortOrder> = { voucherDate: -1, voucherNo: -1 };

    const [docs, count, totals] = await Promise.all([
      this.handoverModel
        .find(scoped)
        .sort(sort)
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean()
        .exec(),
      this.handoverModel.countDocuments(scoped).exec(),
      this.handoverModel
        .aggregate<{ total: number }>([
          { $match: scoped },
          { $match: { status: VoucherStatus.APPROVED } },
          { $group: { _id: null, total: { $sum: '$receivedTotal' } } },
        ])
        .exec(),
    ]);
    const comments = await this.commentsService.countByEntityIds(
      DEF.entityType,
      docs.map((doc) => doc._id),
    );
    return {
      items: docs.map((doc) => ({
        id: doc._id.toString(),
        voucherNo: doc.voucherNo,
        date: doc.voucherDate,
        user: { id: doc.collectedById?.toString() ?? '', name: doc.collectedByName ?? null },
        status: doc.status,
        submittedTotal: doc.submittedTotal ?? 0,
        receivedTotal: doc.receivedTotal ?? null,
        itemCount: doc.items?.length ?? 0,
        createdBy: userRefOf(doc.createdBy),
        createdAt: doc.createdAt ?? null,
        commentCount: comments.get(doc._id.toString()) ?? 0,
      })),
      page,
      pageSize,
      summary: { count, total: round2(totals[0]?.total ?? 0) },
    };
  }

  async findById(id: string, viewer?: Viewer): Promise<CashHandoverDocument> {
    return (await this.posting.findById(DEF, this.model, id, viewer)) as unknown as CashHandoverDocument;
  }

  /** What the user holds in their own cash, wallet and cheque accounts, and how much is already submitted. */
  async pending(query: PendingQueryDto, viewer: Viewer): Promise<PendingCash> {
    const userId = resolveCollectorId(viewer, query.userId);
    const user = await this.usersService.findByIdWithRole(userId);
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    const accounts = await this.holdings(user);
    const total = (key: 'balance' | 'submitted' | 'available') => sum2(accounts.map((account) => account[key]));
    return {
      user: { id: user.id as string, name: user.name },
      accounts,
      totals: { balance: total('balance'), submitted: total('submitted'), available: total('available') },
    };
  }

  /** Records the amounts; the money stays in the user's accounts until approval. */
  async create(dto: CreateCashHandoverDto, actor: Viewer): Promise<CashHandoverDocument> {
    const userId = resolveCollectorId(actor, dto.userId);
    if (dto.lines.length === 0) {
      throw new BadRequestException('A handover needs at least one amount');
    }
    const sourceIds = dto.lines.map((line) => line.sourceAccountId);
    if (new Set(sourceIds).size !== sourceIds.length) {
      throw new BadRequestException('Each source account can appear only once on a handover');
    }

    return runInTransaction(this.connection, async (session) => {
      const user = await this.usersService.findEligibleCollector(userId, DEF.createPermission, session);
      const holdings = new Map((await this.holdings(user, session)).map((account) => [account.accountId, account]));
      const items: HandoverLine[] = dto.lines.map((line) => {
        const account = holdings.get(line.sourceAccountId);
        if (!account) {
          throw new BadRequestException(
            `Account ${line.sourceAccountId} is not one of ${user.name}'s cash, wallet or cheque accounts`,
          );
        }
        const amount = round2(line.amount);
        if (amount > account.available) {
          throw new BadRequestException(
            `${account.code} (${account.name}) has ${account.available.toFixed(2)} available to hand over, not ${amount.toFixed(2)}`,
          );
        }
        return {
          sourceAccountId: new Types.ObjectId(account.accountId),
          sourceAccountName: account.name,
          sourceAccountType: account.type,
          submittedAmount: amount,
          receivedAmount: null,
          receivedIntoAccountId: null,
          receivedIntoAccountName: null,
        };
      });

      const voucherNo = await this.sequenceService.nextCode(DEF.sequence, session);
      const now = new Date();
      const [created] = await this.handoverModel.create(
        [
          {
            voucherNo,
            voucherDate: dto.voucherDate ? new Date(dto.voucherDate) : now,
            collectedById: user._id,
            collectedByName: user.name,
            comments: dto.notes,
            lines: [],
            items,
            submittedTotal: sum2(items.map((item) => item.submittedAmount)),
            status: VoucherStatus.SUBMITTED,
            createdBy: toUserSnapshot(actor),
            createdAt: now,
          },
        ],
        { session },
      );
      await this.record(created, AuditAction.CREATED, actor, now, session);
      return created;
    });
  }

  /**
   * Received <= submitted per source; less needs a reason and leaves the rest
   * in the source account. Debits each receiving account and credits its
   * source, all in one transaction.
   */
  async approve(id: string, dto: ApproveCashHandoverDto, actor: Viewer): Promise<CashHandoverDocument> {
    this.assertMayDecide(actor);
    const scope = await this.posting.scopeFilter(actor, DEF);
    const settings = await this.companyService.ensure();
    const requested = new Map((dto.lines ?? []).map((line) => [line.sourceAccountId, line]));

    return runInTransaction(this.connection, async (session) => {
      const handover = await this.load(id, scope, session);
      this.assertStatus(handover, VoucherStatus.SUBMITTED, 'approved');
      this.assertNotOwn(handover, actor, 'approve');
      const unknown = [...requested.keys()].filter(
        (sourceId) => !handover.items.some((item) => item.sourceAccountId.toString() === sourceId),
      );
      if (unknown.length > 0) {
        throw new BadRequestException(`Not on this handover: ${unknown.join(', ')}`);
      }

      const balances = await this.ledgerAccountService.getBalances(
        handover.items.map((item) => item.sourceAccountId.toString()),
        session,
      );
      let short = false;
      for (const item of handover.items) {
        const line = requested.get(item.sourceAccountId.toString());
        const received = round2(line?.receivedAmount ?? item.submittedAmount);
        if (received > item.submittedAmount) {
          throw new BadRequestException(
            `${item.sourceAccountName}: received ${received.toFixed(2)} is more than the submitted ${item.submittedAmount.toFixed(2)}`,
          );
        }
        const balance = round2(balances.get(item.sourceAccountId.toString()) ?? 0);
        if (received > balance) {
          throw new BadRequestException(
            `${item.sourceAccountName} holds only ${balance.toFixed(2)}, less than the ${received.toFixed(2)} received`,
          );
        }
        const intoId =
          line?.receivedIntoAccountId ??
          (item.sourceAccountType === LedgerAccountType.CHEQUE
            ? settings.defaultChequesInHandAccountId
            : settings.defaultCashInHandAccountId
          )?.toString();
        if (!intoId) {
          throw new BadRequestException(
            `${item.sourceAccountName}: choose a receivedIntoAccountId, or set the company's default ${item.sourceAccountType === LedgerAccountType.CHEQUE ? 'cheques' : 'cash'} in hand account`,
          );
        }
        if (intoId === item.sourceAccountId.toString()) {
          throw new BadRequestException(`${item.sourceAccountName}: the receiving account must be a different account`);
        }
        const into = await this.ledgerAccountService.findActiveReceiptAccount(intoId, RECEIVE_INTO_TYPES);
        short ||= received < item.submittedAmount;
        item.receivedAmount = received;
        item.receivedIntoAccountId = into._id;
        item.receivedIntoAccountName = into.name;
      }
      const reason = dto.reason?.trim() || null;
      if (short && !reason) {
        throw new BadRequestException('Less than submitted was received: a reason is required');
      }

      const now = new Date();
      const receivedTotal = sum2(handover.items.map((item) => item.receivedAmount ?? 0));
      handover.markModified('items');
      handover.receivedTotal = receivedTotal;
      handover.grossTotal = receivedTotal;
      handover.grandTotal = receivedTotal;
      handover.reason = short ? reason : null;
      handover.status = VoucherStatus.APPROVED;
      handover.approvedBy = toUserSnapshot(actor);
      handover.approvedAt = now;
      await handover.save({ session });

      await this.posting.postTransfers(this.ref(handover), this.transfers(handover), LedgerEntryKind.POSTING, 'approved', session);
      await this.record(handover, AuditAction.APPROVED, actor, now, session, {
        changes: [
          this.statusChange(VoucherStatus.SUBMITTED, VoucherStatus.APPROVED),
          { field: 'receivedTotal', label: 'Received', from: null, to: receivedTotal.toFixed(2) },
        ],
        reason: handover.reason ?? undefined,
      });
      return handover;
    });
  }

  /** Nothing was posted: the money simply stays pending. */
  async reject(id: string, dto: RejectCashHandoverDto, actor: Viewer): Promise<CashHandoverDocument> {
    this.assertMayDecide(actor);
    const reason = dto.reason.trim();
    const scope = await this.posting.scopeFilter(actor, DEF);

    return runInTransaction(this.connection, async (session) => {
      const handover = await this.load(id, scope, session);
      this.assertStatus(handover, VoucherStatus.SUBMITTED, 'rejected');
      this.assertNotOwn(handover, actor, 'reject');
      const now = new Date();
      handover.status = VoucherStatus.REJECTED;
      handover.rejectedBy = toUserSnapshot(actor);
      handover.rejectedAt = now;
      handover.reason = reason;
      await handover.save({ session });
      await this.record(handover, AuditAction.REJECTED, actor, now, session, {
        changes: [this.statusChange(VoucherStatus.SUBMITTED, VoucherStatus.REJECTED)],
        reason,
      });
      return handover;
    });
  }

  /**
   * Submitted: by its submitter or the user it is for, or anyone with
   * cash-handovers:cancel. Approved: cash-handovers:cancel only; the posting
   * is reversed, so the money is pending again.
   */
  async cancel(id: string, dto: CancelCashHandoverDto, actor: Viewer): Promise<CashHandoverDocument> {
    const reason = dto.reason.trim();
    const scope = await this.posting.scopeFilter(actor, DEF);
    const canCancelAny = hasPermission(actor, Permission.CASH_HANDOVERS_CANCEL);

    return runInTransaction(this.connection, async (session) => {
      const handover = await this.load(id, scope, session);
      const from = handover.status;
      if (from === VoucherStatus.SUBMITTED) {
        const own = handover.createdBy?.id.toString() === actor.id || handover.collectedById?.toString() === actor.id;
        if (!canCancelAny && !own) {
          throw new ForbiddenException('Only the submitter, or a user who may cancel handovers, can cancel it');
        }
      } else if (from === VoucherStatus.APPROVED) {
        if (!canCancelAny) {
          throw new ForbiddenException('Cancelling an approved handover needs the cash-handovers:cancel permission');
        }
        await this.posting.postTransfers(this.ref(handover), this.transfers(handover), LedgerEntryKind.REVERSAL, 'cancelled', session);
      } else {
        throw new BadRequestException(`${DEF.label} ${handover.voucherNo} is ${from} and cannot be cancelled`);
      }

      const now = new Date();
      handover.status = VoucherStatus.CANCELLED;
      handover.cancelledBy = toUserSnapshot(actor);
      handover.cancelledAt = now;
      handover.cancelReason = reason;
      await handover.save({ session });
      await this.record(handover, AuditAction.CANCELLED, actor, now, session, {
        changes: [this.statusChange(from, VoucherStatus.CANCELLED)],
        reason,
      });
      return handover;
    });
  }

  /** CASH HANDOVER SLIP, ORIGINAL then DUPLICATEs; every call is audited as a print. */
  async print(id: string, actor: Viewer): Promise<PrintedVoucher> {
    return this.printService.print(DEF, this.model, id, actor, await this.posting.scopeFilter(actor, DEF));
  }

  /** The user's own cash, wallet and cheque accounts, with balance, already-submitted and available amounts. */
  private async holdings(user: UserDocument, session?: ClientSession): Promise<PendingAccount[]> {
    const ids = (user.allowedCashAccountIds ?? []).map((accountId) => accountId.toString());
    const [summaries, balances, submitted] = await Promise.all([
      this.ledgerAccountService.getSummaries(ids, session),
      this.ledgerAccountService.getBalances(ids, session),
      this.submittedBySource(user._id, session),
    ]);
    return ids.flatMap((accountId) => {
      const summary = summaries.get(accountId);
      if (!summary || !CASH_LIKE_ACCOUNT_TYPES.includes(summary.type)) return [];
      const balance = round2(balances.get(accountId) ?? 0);
      const onHandovers = round2(submitted.get(accountId) ?? 0);
      return [
        {
          accountId,
          code: summary.code,
          name: summary.name,
          type: summary.type,
          balance,
          submitted: onHandovers,
          available: round2(balance - onHandovers),
        },
      ];
    });
  }

  /** Amounts on the user's submitted handovers, by source account. */
  private async submittedBySource(userId: Types.ObjectId, session?: ClientSession): Promise<Map<string, number>> {
    const rows = await this.handoverModel
      .aggregate<{ _id: Types.ObjectId; total: number }>([
        { $match: { collectedById: userId, status: VoucherStatus.SUBMITTED } },
        { $unwind: '$items' },
        { $group: { _id: '$items.sourceAccountId', total: { $sum: '$items.submittedAmount' } } },
      ])
      .session(session ?? null)
      .exec();
    return new Map(rows.map((row) => [row._id.toString(), row.total]));
  }

  private transfers(handover: CashHandoverDocument) {
    return handover.items.map((item) => ({
      fromAccountId: item.sourceAccountId.toString(),
      toAccountId: item.receivedIntoAccountId!.toString(),
      amount: item.receivedAmount ?? 0,
      narration: `Handover ${handover.voucherNo}`,
    }));
  }

  private ref(handover: CashHandoverDocument) {
    return {
      entityType: DEF.entityType,
      id: handover._id,
      voucherNo: handover.voucherNo,
      voucherDate: handover.voucherDate,
    };
  }

  /** Van salesmen ("own"-scoped users) never approve or reject, whatever their role grants. */
  private assertMayDecide(actor: Viewer): void {
    if (isOwnScope(actor)) {
      throw new ForbiddenException('Users who see only their own vouchers cannot approve or reject handovers');
    }
  }

  /** Nobody decides on a handover they submitted or that hands over their own money. */
  private assertNotOwn(handover: CashHandoverDocument, actor: Viewer, action: string): void {
    if (handover.createdBy?.id.toString() === actor.id || handover.collectedById?.toString() === actor.id) {
      throw new ForbiddenException(`You submitted this handover (or it is yours), so someone else must ${action} it`);
    }
  }

  private async load(id: string, scope: Record<string, unknown> | null, session: ClientSession) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`${DEF.label} id "${id}" is not a valid id`);
    }
    const handover = await this.handoverModel
      .findOne(withScope({ _id: new Types.ObjectId(id) }, scope))
      .session(session)
      .exec();
    if (!handover) {
      throw new NotFoundException(`${DEF.label} ${id} not found`);
    }
    return handover;
  }

  private record(
    handover: CashHandoverDocument,
    action: AuditAction,
    actor: Actor,
    at: Date,
    session: ClientSession,
    extra: { changes?: AuditChange[]; reason?: string } = {},
  ) {
    return this.auditService.record(
      { entityType: DEF.entityType, entityId: handover._id, entityRef: handover.voucherNo, action, actor, at, ...extra },
      session,
    );
  }

  private statusChange(from: string, to: string): AuditChange {
    return { field: 'status', label: 'Status', from, to };
  }

  private assertStatus(handover: CashHandoverDocument, expected: VoucherStatus, action: string): void {
    if (handover.status !== expected) {
      throw new BadRequestException(`${DEF.label} ${handover.voucherNo} is ${handover.status} and cannot be ${action}`);
    }
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
