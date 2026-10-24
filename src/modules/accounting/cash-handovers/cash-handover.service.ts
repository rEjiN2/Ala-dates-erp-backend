import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model, SortOrder } from 'mongoose';
import {
  CashHandover,
  CashHandoverDocument,
  type HandoverBankReceipt,
  type HandoverCheque,
  ExpensePaidFrom,
  type HandoverExpense,
  type HandoverLine,
} from './schemas/cash-handover.schema.js';
import { CashReceipt, CashReceiptDocument } from '../cash-receipts/schemas/cash-receipt.schema.js';
import { CashPayment } from '../cash-payments/schemas/cash-payment.schema.js';
import { FilesService } from '../../files/files.service.js';
import { FileOwnerType } from '../../files/schemas/file-attachment.schema.js';
import { LedgerEntry } from '../vouchers/schemas/ledger-entry.schema.js';
import { CHEQUE_ENTITY_TYPE } from '../cheques/cheque.service.js';
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
import { BankHandoverStatus, ChequeStatus, PaymentMethod, VoucherStatus } from '../vouchers/schemas/voucher.schema.js';
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

/** A cheque the user collected and still holds (with_salesman). */
export interface PendingCheque {
  /** The receipt's id. */
  id: string;
  voucherNo: string;
  chequeNumber: string;
  chequeBankName: string | null;
  chequeDate: Date | null;
  amount: number;
}

export interface PendingCash {
  user: Ref;
  accounts: PendingAccount[];
  totals: { balance: number; submitted: number; available: number };
  /** Cheques they hold, not yet on a handover. */
  cheques: PendingCheque[];
  chequesTotal: number;
  /** Bank-transfer receipts they collected, not yet on a handover. */
  bankReceipts: PendingBankReceipt[];
  bankReceiptsTotal: number;
}

/** A bank-transfer receipt the user collected, to be verified by the office. */
export interface PendingBankReceipt {
  /** The receipt's id. */
  id: string;
  voucherNo: string;
  bankAccountName: string | null;
  reference: string | null;
  amount: number;
  attachmentCount: number;
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
    @InjectModel(CashHandover.name)
    private readonly handoverModel: Model<CashHandoverDocument>,
    @InjectModel(CashReceipt.name)
    private readonly receiptModel: Model<CashReceiptDocument>,
    @InjectModel(CashPayment.name)
    private readonly paymentModel: Model<CashPayment>,
    @InjectModel(LedgerEntry.name)
    private readonly entryModel: Model<LedgerEntry>,
    private readonly posting: VoucherPostingService,
    private readonly printService: VoucherPrintService,
    private readonly ledgerAccountService: LedgerAccountService,
    private readonly usersService: UsersService,
    private readonly companyService: CompanyService,
    private readonly commentsService: CommentsService,
    private readonly sequenceService: SequenceService,
    private readonly auditService: AuditService,
    private readonly filesService: FilesService,
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
        user: {
          id: doc.collectedById?.toString() ?? '',
          name: doc.collectedByName ?? null,
        },
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
    const [accounts, cheques, bankReceipts] = await Promise.all([
      this.holdings(user),
      this.heldCheques(user._id),
      this.heldBankReceipts(user._id),
    ]);
    const total = (key: 'balance' | 'submitted' | 'available') => sum2(accounts.map((account) => account[key]));
    return {
      user: { id: user.id as string, name: user.name },
      accounts,
      totals: {
        balance: total('balance'),
        submitted: total('submitted'),
        available: total('available'),
      },
      cheques: cheques.map((cheque) => ({
        id: cheque.receiptId.toString(),
        voucherNo: cheque.voucherNo,
        chequeNumber: cheque.chequeNumber,
        chequeBankName: cheque.chequeBankName,
        chequeDate: cheque.chequeDate,
        amount: cheque.amount,
      })),
      chequesTotal: sum2(cheques.map((cheque) => cheque.amount)),
      bankReceipts: bankReceipts.map((receipt) => ({
        id: receipt.receiptId.toString(),
        voucherNo: receipt.voucherNo,
        bankAccountName: receipt.bankAccountName,
        reference: receipt.reference,
        amount: receipt.amount,
        attachmentCount: receipt.attachments.length,
      })),
      bankReceiptsTotal: sum2(bankReceipts.map((receipt) => receipt.amount)),
    };
  }

  /** Records the amounts; the money stays in the user's accounts until approval. */
  async create(dto: CreateCashHandoverDto, actor: Viewer): Promise<CashHandoverDocument> {
    const userId = resolveCollectorId(actor, dto.userId);
    const chequeIds = [...new Set(dto.chequeIds ?? [])];
    const expenseInputs = dto.expenses ?? [];
    // Only expenses paid from the user's own cash reduce what they can hand over.
    const ownExpenses = expenseInputs.filter((e) => (e.paidFrom ?? ExpensePaidFrom.OWN) === ExpensePaidFrom.OWN);
    const bankReceiptIds = [...new Set(dto.bankReceiptIds ?? [])];
    if (dto.lines.length === 0 && chequeIds.length === 0 && expenseInputs.length === 0 && bankReceiptIds.length === 0) {
      throw new BadRequestException('A handover needs at least one amount, cheque, bank receipt or expense');
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
        const spent = sum2(
          ownExpenses.filter((e) => e.sourceAccountId === line.sourceAccountId).map((e) => e.amount),
        );
        if (round2(amount + spent) > account.available) {
          throw new BadRequestException(
            `${account.code} (${account.name}) has ${account.available.toFixed(2)} available to hand over, not ${round2(amount + spent).toFixed(2)}${spent ? ` (including ${spent.toFixed(2)} of expenses)` : ''}`,
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

      const expenses: HandoverExpense[] = [];
      const pettyCash = expenseInputs.some((e) => e.paidFrom === ExpensePaidFrom.PETTY_CASH)
        ? await this.pettyCashAccount()
        : null;
      for (const input of expenseInputs) {
        if (input.paidFrom === ExpensePaidFrom.PETTY_CASH) {
          const account = await this.ledgerAccountService.findActiveReceiptAccount(input.expenseAccountId, [
            LedgerAccountType.EXPENSE,
          ]);
          expenses.push({
            expenseAccountId: account._id,
            expenseAccountName: account.name,
            paidFrom: ExpensePaidFrom.PETTY_CASH,
            sourceAccountId: pettyCash!._id,
            sourceAccountName: pettyCash!.name,
            amount: round2(input.amount),
            description: input.description ?? null,
            attachment: null,
          });
          continue;
        }
        const source = input.sourceAccountId ? holdings.get(input.sourceAccountId) : undefined;
        if (!source || source.type === LedgerAccountType.CHEQUE) {
          throw new BadRequestException(`An expense must be paid from one of ${user.name}'s cash or wallet accounts`);
        }
        // Paid from an account with no amount handed over: still within what is held.
        if (!dto.lines.some((line) => line.sourceAccountId === input.sourceAccountId)) {
          const spent = sum2(
            ownExpenses.filter((e) => e.sourceAccountId === input.sourceAccountId).map((e) => e.amount),
          );
          if (spent > source.available) {
            throw new BadRequestException(
              `${source.code} (${source.name}) has ${source.available.toFixed(2)} available, less than ${spent.toFixed(2)} of expenses`,
            );
          }
        }
        const account = await this.ledgerAccountService.findActiveReceiptAccount(input.expenseAccountId, [
          LedgerAccountType.EXPENSE,
        ]);
        expenses.push({
          expenseAccountId: account._id,
          expenseAccountName: account.name,
          paidFrom: ExpensePaidFrom.OWN,
          sourceAccountId: new Types.ObjectId(source.accountId),
          sourceAccountName: source.name,
          amount: round2(input.amount),
          description: input.description ?? null,
          attachment: null,
        });
      }

      const held = new Map(
        (await this.heldCheques(user._id, session)).map((cheque) => [cheque.receiptId.toString(), cheque]),
      );
      const cheques: HandoverCheque[] = chequeIds.map((chequeId) => {
        const cheque = held.get(chequeId);
        if (!cheque) {
          throw new BadRequestException(`Receipt ${chequeId} has no cheque that ${user.name} still holds`);
        }
        return cheque;
      });

      const heldBank = new Map(
        (await this.heldBankReceipts(user._id, session)).map((receipt) => [receipt.receiptId.toString(), receipt]),
      );
      const bankReceipts: HandoverBankReceipt[] = bankReceiptIds.map((receiptId) => {
        const receipt = heldBank.get(receiptId);
        if (!receipt) {
          throw new BadRequestException(
            `Receipt ${receiptId} is not a bank receipt that ${user.name} still has to hand over`,
          );
        }
        return receipt;
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
            cheques,
            bankReceipts,
            expenses,
            expensesTotal: sum2(expenses.map((expense) => expense.amount)),
            submittedTotal: sum2([
              ...items.map((item) => item.submittedAmount),
              ...cheques.map((cheque) => cheque.amount),
              ...bankReceipts.map((receipt) => receipt.amount),
            ]),
            status: VoucherStatus.SUBMITTED,
            createdBy: toUserSnapshot(actor),
            createdAt: now,
          },
        ],
        { session },
      );
      await this.moveCheques(
        created,
        ChequeStatus.WITH_SALESMAN,
        ChequeStatus.SUBMITTED,
        'Handed over',
        actor,
        session,
      );
      await this.moveBankReceipts(created, BankHandoverStatus.WITH_SALESMAN, BankHandoverStatus.SUBMITTED, session);
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

      const user = await this.usersService.findByIdWithRole(handover.collectedById!.toString());
      const held = new Map(
        (user ? await this.holdings(user, session) : []).map((account) => [account.accountId, account.balance]),
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
        const spent = sum2(
          (handover.expenses ?? [])
            .filter((e) => e.paidFrom !== ExpensePaidFrom.PETTY_CASH && e.sourceAccountId.equals(item.sourceAccountId))
            .map((e) => e.amount),
        );
        const balance = round2((held.get(item.sourceAccountId.toString()) ?? 0) - spent);
        if (received > balance) {
          throw new BadRequestException(
            `${item.sourceAccountName} holds only ${balance.toFixed(2)}, less than the ${received.toFixed(2)} received`,
          );
        }
        const intoId =
          line?.receivedIntoAccountId ??
          (item.sourceAccountType === LedgerAccountType.CHEQUE
            ? settings.defaultChequesInHandAccountId
            : item.sourceAccountType === LedgerAccountType.BANK
              ? item.sourceAccountId
              : settings.defaultCashInHandAccountId
          )?.toString();
        if (!intoId) {
          throw new BadRequestException(
            `${item.sourceAccountName}: choose a receivedIntoAccountId, or set the company's default ${item.sourceAccountType === LedgerAccountType.CHEQUE ? 'cheques' : 'cash'} in hand account`,
          );
        }
        const into = await this.ledgerAccountService.findActiveReceiptAccount(intoId, RECEIVE_INTO_TYPES);
        short ||= received < item.submittedAmount;
        item.receivedAmount = received;
        item.receivedIntoAccountId = into._id;
        item.receivedIntoAccountName = into.name;
      }
      await this.assertPettyCashCovers(handover, session);
      const reason = dto.reason?.trim() || null;
      if (short && !reason) {
        throw new BadRequestException('Less than submitted was received: a reason is required');
      }

      const now = new Date();
      const receivedTotal = sum2([
        ...handover.items.map((item) => item.receivedAmount ?? 0),
        ...(handover.cheques ?? []).map((cheque) => cheque.amount),
        ...(handover.bankReceipts ?? []).map((receipt) => receipt.amount),
      ]);
      handover.markModified('items');
      handover.receivedTotal = receivedTotal;
      handover.grossTotal = receivedTotal;
      handover.grandTotal = receivedTotal;
      handover.reason = short ? reason : null;
      handover.status = VoucherStatus.APPROVED;
      handover.approvedBy = toUserSnapshot(actor);
      handover.approvedAt = now;
      await handover.save({ session });

      if (this.transfers(handover).length > 0) {
        await this.posting.postTransfers(
          this.ref(handover),
          this.transfers(handover),
          LedgerEntryKind.POSTING,
          'approved',
          session,
        );
      }
      await this.moveCheques(
        handover,
        ChequeStatus.SUBMITTED,
        ChequeStatus.AT_OFFICE,
        'Received at the office',
        actor,
        session,
      );
      await this.moveBankReceipts(handover, BankHandoverStatus.SUBMITTED, BankHandoverStatus.VERIFIED, session);
      await this.record(handover, AuditAction.APPROVED, actor, now, session, {
        changes: [
          this.statusChange(VoucherStatus.SUBMITTED, VoucherStatus.APPROVED),
          {
            field: 'receivedTotal',
            label: 'Received',
            from: null,
            to: receivedTotal.toFixed(2),
          },
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
      await this.moveCheques(
        handover,
        ChequeStatus.SUBMITTED,
        ChequeStatus.WITH_SALESMAN,
        'Handover rejected',
        actor,
        session,
      );
      await this.moveBankReceipts(handover, BankHandoverStatus.SUBMITTED, BankHandoverStatus.WITH_SALESMAN, session);
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
        await this.moveCheques(
          handover,
          ChequeStatus.SUBMITTED,
          ChequeStatus.WITH_SALESMAN,
          'Handover cancelled',
          actor,
          session,
        );
        await this.moveBankReceipts(handover, BankHandoverStatus.SUBMITTED, BankHandoverStatus.WITH_SALESMAN, session);
      } else if (from === VoucherStatus.APPROVED) {
        if (!canCancelAny) {
          throw new ForbiddenException('Cancelling an approved handover needs the cash-handovers:cancel permission');
        }
        if (this.transfers(handover).length > 0) {
          await this.posting.postTransfers(
            this.ref(handover),
            this.transfers(handover),
            LedgerEntryKind.REVERSAL,
            'cancelled',
            session,
          );
        }
        await this.moveCheques(
          handover,
          ChequeStatus.AT_OFFICE,
          ChequeStatus.WITH_SALESMAN,
          'Handover cancelled',
          actor,
          session,
        );
        await this.moveBankReceipts(handover, BankHandoverStatus.VERIFIED, BankHandoverStatus.WITH_SALESMAN, session);
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

  /**
   * The user's cash, wallet and cheque accounts with what *they* hold in each,
   * already-submitted and available amounts. The accounts may be shared
   * masters (Cash in Hand, ...), so what they hold is not the balance but
   * their own postings: entries of vouchers they collected or handed over,
   * less handovers approved into the same account (nothing posted there).
   */
  private async holdings(user: UserDocument, session?: ClientSession): Promise<PendingAccount[]> {
    const ids = (user.allowedCashAccountIds ?? []).map((accountId) => accountId.toString());
    const [summaries, balances, submitted] = await Promise.all([
      this.ledgerAccountService.getSummaries(ids, session),
      this.heldBy(user._id, ids, session),
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

  /** Cheques the user collected and still holds: on their receipts, with_salesman, not cancelled. */
  private async heldCheques(userId: Types.ObjectId, session?: ClientSession): Promise<HandoverCheque[]> {
    const receipts = await this.receiptModel
      .find({
        collectedById: userId,
        paymentMethod: PaymentMethod.CHEQUE,
        chequeStatus: ChequeStatus.WITH_SALESMAN,
        status: { $ne: VoucherStatus.CANCELLED },
      })
      .sort({ chequeDate: 1, voucherNo: 1 })
      .session(session ?? null)
      .lean()
      .exec();
    return receipts.map((receipt) => ({
      receiptId: receipt._id,
      voucherNo: receipt.voucherNo,
      chequeNumber: receipt.chequeNumber ?? '',
      chequeBankName: receipt.chequeBankName ?? null,
      chequeDate: receipt.chequeDate ?? null,
      amount: receipt.grandTotal,
      attachments: attachmentsOf(receipt),
    }));
  }

  /** Bank-transfer receipts the user collected that the office has not yet verified on a handover. */
  private async heldBankReceipts(userId: Types.ObjectId, session?: ClientSession): Promise<HandoverBankReceipt[]> {
    const receipts = await this.receiptModel
      .find({
        collectedById: userId,
        paymentMethod: PaymentMethod.BANK,
        bankHandoverStatus: BankHandoverStatus.WITH_SALESMAN,
        status: { $ne: VoucherStatus.CANCELLED },
      })
      .sort({ voucherDate: 1, voucherNo: 1 })
      .session(session ?? null)
      .lean()
      .exec();
    const names = await this.ledgerAccountService.getNames(
      receipts.map((receipt) => receipt.cashAccountId.toString()),
      session,
    );
    return receipts.map((receipt) => ({
      receiptId: receipt._id,
      voucherNo: receipt.voucherNo,
      bankAccountName: names.get(receipt.cashAccountId.toString()) ?? null,
      reference: receipt.paymentReference ?? null,
      amount: receipt.grandTotal,
      attachments: attachmentsOf(receipt),
    }));
  }

  /** Moves the handover's bank receipts between handover states; every one must still be in `from`. */
  private async moveBankReceipts(
    handover: CashHandoverDocument,
    from: BankHandoverStatus,
    to: BankHandoverStatus,
    session: ClientSession,
  ): Promise<void> {
    const receipts = handover.bankReceipts ?? [];
    if (receipts.length === 0) return;
    const result = await this.receiptModel
      .updateMany(
        { _id: { $in: receipts.map((receipt) => receipt.receiptId) }, bankHandoverStatus: from },
        { $set: { bankHandoverStatus: to } },
        { session },
      )
      .exec();
    if (result.modifiedCount !== receipts.length) {
      throw new BadRequestException(`A bank receipt on ${handover.voucherNo} is no longer ${from.replace('_', ' ')}`);
    }
  }

  /**
   * Moves the handover's cheques from one status to the next, each with a
   * "cheque" audit entry. All must still be in `from`: a cheque deposited
   * since blocks cancelling the handover until that is undone.
   */
  private async moveCheques(
    handover: CashHandoverDocument,
    from: ChequeStatus,
    to: ChequeStatus,
    detail: string,
    actor: Actor,
    session: ClientSession,
  ): Promise<void> {
    const cheques = handover.cheques ?? [];
    if (cheques.length === 0) return;
    const result = await this.receiptModel
      .updateMany(
        {
          _id: { $in: cheques.map((cheque) => cheque.receiptId) },
          chequeStatus: from,
        },
        { $set: { chequeStatus: to } },
        { session },
      )
      .exec();
    if (result.modifiedCount !== cheques.length) {
      throw new BadRequestException(
        `A cheque on ${handover.voucherNo} is no longer ${from.replace('_', ' ')}; undo its later step first`,
      );
    }
    for (const cheque of cheques) {
      await this.auditService.record(
        {
          entityType: CHEQUE_ENTITY_TYPE,
          entityId: cheque.receiptId,
          entityRef: `${cheque.chequeNumber} (${cheque.voucherNo})`,
          action: AuditAction.UPDATED,
          actor,
          changes: [
            { field: 'chequeStatus', label: 'Status', from, to },
            {
              field: 'detail',
              label: 'Detail',
              from: null,
              to: `${detail} on ${handover.voucherNo}`,
            },
          ],
        },
        session,
      );
    }
  }

  /** Per account: the user's own net postings, less same-account approvals. */
  private async heldBy(
    userId: Types.ObjectId,
    accountIds: string[],
    session?: ClientSession,
  ): Promise<Map<string, number>> {
    const mine = { collectedById: userId };
    const [receipts, payments, handovers] = await Promise.all([
      this.receiptModel
        .distinct('_id', mine)
        .session(session ?? null)
        .exec(),
      this.paymentModel
        .distinct('_id', mine)
        .session(session ?? null)
        .exec(),
      this.handoverModel
        .distinct('_id', mine)
        .session(session ?? null)
        .exec(),
    ]);
    const [posted, settledInPlace] = await Promise.all([
      this.entryModel
        .aggregate<{ _id: Types.ObjectId; net: number }>([
          {
            $match: {
              accountId: {
                $in: accountIds.map((id) => new Types.ObjectId(id)),
              },
              voucherId: { $in: [...receipts, ...payments, ...handovers] },
            },
          },
          {
            $group: {
              _id: '$accountId',
              net: { $sum: { $subtract: ['$debit', '$credit'] } },
            },
          },
        ])
        .session(session ?? null)
        .exec(),
      this.handoverModel
        .aggregate<{ _id: Types.ObjectId; total: number }>([
          { $match: { collectedById: userId, status: VoucherStatus.APPROVED } },
          { $unwind: '$items' },
          {
            $match: {
              $expr: {
                $eq: ['$items.sourceAccountId', '$items.receivedIntoAccountId'],
              },
            },
          },
          {
            $group: {
              _id: '$items.sourceAccountId',
              total: { $sum: '$items.receivedAmount' },
            },
          },
        ])
        .session(session ?? null)
        .exec(),
    ]);
    const held = new Map(posted.map((row) => [row._id.toString(), row.net]));
    for (const row of settledInPlace) {
      held.set(row._id.toString(), (held.get(row._id.toString()) ?? 0) - row.total);
    }
    return held;
  }

  /** The company default petty cash account, which pays expense claims. */
  private async pettyCashAccount() {
    const id = (await this.companyService.ensure()).defaultPettyCashAccountId;
    if (!id) {
      throw new BadRequestException(
        'Petty cash claims need a default petty cash account in the company settings',
      );
    }
    return this.ledgerAccountService.findActiveReceiptAccount(id.toString(), [
      LedgerAccountType.CASH,
      LedgerAccountType.WALLET,
    ]);
  }

  /** Petty cash claims may not take a petty cash account below zero. */
  private async assertPettyCashCovers(handover: CashHandoverDocument, session: ClientSession): Promise<void> {
    const claimed = new Map<string, { name: string; amount: number }>();
    for (const expense of handover.expenses ?? []) {
      if (expense.paidFrom !== ExpensePaidFrom.PETTY_CASH) continue;
      const key = expense.sourceAccountId.toString();
      const row = claimed.get(key) ?? { name: expense.sourceAccountName, amount: 0 };
      claimed.set(key, { name: row.name, amount: round2(row.amount + expense.amount) });
    }
    if (claimed.size === 0) return;
    const balances = await this.ledgerAccountService.getBalances([...claimed.keys()], session);
    for (const [id, { name, amount }] of claimed) {
      const balance = round2(balances.get(id) ?? 0);
      if (amount > balance) {
        throw new BadRequestException(
          `${name} holds only ${balance.toFixed(2)}, less than the ${amount.toFixed(2)} of expense claims`,
        );
      }
    }
  }

  /** Amounts on the user's submitted handovers, by source account. */
  private async submittedBySource(userId: Types.ObjectId, session?: ClientSession): Promise<Map<string, number>> {
    const rows = await this.handoverModel
      .aggregate<{ _id: Types.ObjectId; total: number }>([
        { $match: { collectedById: userId, status: VoucherStatus.SUBMITTED } },
        // Amounts and expenses both reserve their source until approval.
        {
          $project: {
            rows: {
              $concatArrays: [
                {
                  $map: { input: '$items', in: { source: '$$this.sourceAccountId', amount: '$$this.submittedAmount' } },
                },
                {
                  $map: {
                    input: { $ifNull: ['$expenses', []] },
                    in: { source: '$$this.sourceAccountId', amount: '$$this.amount' },
                  },
                },
              ],
            },
          },
        },
        { $unwind: '$rows' },
        { $group: { _id: '$rows.source', total: { $sum: '$rows.amount' } } },
      ])
      .session(session ?? null)
      .exec();
    return new Map(rows.map((row) => [row._id.toString(), row.total]));
  }

  /**
   * Received into another account (one received into its own source posts
   * nothing), and each expense out of its source into the expense account.
   */
  private transfers(handover: CashHandoverDocument) {
    return [
      ...handover.items
        .filter((item) => !item.receivedIntoAccountId?.equals(item.sourceAccountId))
        .map((item) => ({
          fromAccountId: item.sourceAccountId.toString(),
          toAccountId: item.receivedIntoAccountId!.toString(),
          amount: item.receivedAmount ?? 0,
          narration: `Handover ${handover.voucherNo}`,
        })),
      ...(handover.expenses ?? []).map((expense) => ({
        fromAccountId: expense.sourceAccountId.toString(),
        toAccountId: expense.expenseAccountId.toString(),
        amount: expense.amount,
        narration: `Handover ${handover.voucherNo}: ${expense.description ?? expense.expenseAccountName}`,
      })),
    ];
  }

  /**
   * Attaches (or replaces) the bill of one expense, while the handover is
   * submitted, by whoever submitted it or whose money it is. The old file is
   * removed after the commit; a failed attach removes the new one.
   */
  async attachExpenseBill(
    id: string,
    expenseId: string,
    file: Express.Multer.File | undefined,
    actor: Viewer,
  ): Promise<CashHandoverDocument> {
    const handover = await this.findById(id, actor);
    this.assertStatus(handover, VoucherStatus.SUBMITTED, 'changed');
    const own = handover.createdBy?.id.toString() === actor.id || handover.collectedById?.toString() === actor.id;
    if (!own) {
      throw new ForbiddenException('Only the submitter can attach bills to this handover');
    }
    if (!Types.ObjectId.isValid(expenseId) || !handover.expenses.some((e) => e._id.equals(expenseId))) {
      throw new NotFoundException(`Expense ${expenseId} not found on ${handover.voucherNo}`);
    }
    const stored = await this.filesService.upload(
      file,
      { ownerType: FileOwnerType.CASH_HANDOVER, ownerId: id },
      actor.id,
    );
    let replaced: string | null = null;
    try {
      const saved = await runInTransaction(this.connection, async (session) => {
        const current = await this.load(id, null, session);
        const expense = current.expenses.find((e) => e._id.equals(expenseId))!;
        replaced = expense.attachment?.fileRef.toString() ?? null;
        expense.attachment = {
          fileRef: new Types.ObjectId(stored.id),
          title: stored.originalName,
          mimeType: stored.mimeType,
        };
        current.markModified('expenses');
        await current.save({ session });
        await this.record(current, AuditAction.UPDATED, actor, new Date(), session, {
          changes: [
            { field: 'expenses', label: `Bill for ${expense.expenseAccountName}`, from: null, to: stored.originalName },
          ],
        });
        return current;
      });
      if (replaced) await this.filesService.remove(replaced).catch(() => undefined);
      return saved;
    } catch (error) {
      await this.filesService.remove(stored.id).catch(() => undefined);
      throw error;
    }
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
      {
        entityType: DEF.entityType,
        entityId: handover._id,
        entityRef: handover.voucherNo,
        action,
        actor,
        at,
        ...extra,
      },
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

/** A receipt's attachments as a handover snapshot (cheque photo, transfer slip). */
function attachmentsOf(receipt: {
  attachments?: { fileRef: Types.ObjectId; title: string; mimeType: string }[];
}): { fileRef: Types.ObjectId; title: string; mimeType: string }[] {
  return (receipt.attachments ?? []).map(({ fileRef, title, mimeType }) => ({ fileRef, title, mimeType }));
}
