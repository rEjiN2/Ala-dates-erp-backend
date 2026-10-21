import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import { CashReceipt, CashReceiptDocument, type ChequeStep } from '../cash-receipts/schemas/cash-receipt.schema.js';
import { CASH_RECEIPT_DEFINITION } from '../cash-receipts/cash-receipt.definition.js';
import { ChequeStatus, PaymentMethod, VoucherStatus } from '../vouchers/schemas/voucher.schema.js';
import { LedgerEntryKind } from '../vouchers/schemas/ledger-entry.schema.js';
import { VoucherPostingService } from '../vouchers/voucher-posting.service.js';
import type { VoucherDocument } from '../vouchers/schemas/voucher.schema.js';
import { withScope, type ScopedUser } from '../vouchers/data-scope.js';
import { LedgerAccountService } from '../ledger-accounts/ledger-account.service.js';
import { LedgerAccountType } from '../ledger-accounts/schemas/ledger-account.schema.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction } from '../../audit/schemas/audit-log.schema.js';
import { CommentsService } from '../../comments/comments.service.js';
import { EntityAccessRegistry } from '../../comments/entity-access.registry.js';
import { ADMIN_ROLE_NAME, Permission, hasPermission } from '../../roles/permissions.js';
import { escapeRegExp } from '../../sequence/code-sequence.js';
import { type Actor, toUserSnapshot } from '../../../common/schemas/user-snapshot.schema.js';
import { round2 } from '../../../common/utils/money.util.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';
import type {
  ChequeQueryDto,
  ClearChequeDto,
  DepositChequeDto,
  ReturnChequeDto,
  UndoChequeDto,
} from './dto/cheque.dto.js';

/** Audit, comments and ledger entries of cheque steps use this entity type, with the receipt's id. */
export const CHEQUE_ENTITY_TYPE = 'cheque';

type Viewer = Actor & ScopedUser & { role?: { name: string } };

const DEF = CASH_RECEIPT_DEFINITION;

/** Not yet cleared or returned: money still on its way. */
const PENDING: readonly ChequeStatus[] = [
  ChequeStatus.WITH_SALESMAN,
  ChequeStatus.SUBMITTED,
  ChequeStatus.AT_OFFICE,
  ChequeStatus.DEPOSITED,
];
/** Pending and not yet at the bank. */
const UNDEPOSITED: readonly ChequeStatus[] = [ChequeStatus.WITH_SALESMAN, ChequeStatus.SUBMITTED, ChequeStatus.AT_OFFICE];
const CLEAR_INTO_TYPES: readonly LedgerAccountType[] = [LedgerAccountType.BANK, LedgerAccountType.CASH, LedgerAccountType.WALLET];
const DAY_MS = 24 * 60 * 60 * 1000;

type Ref = { id: string; name: string | null };

export interface ChequeRow {
  /** The receipt's id. */
  id: string;
  voucherNo: string;
  receiptDate: Date;
  chequeNumber: string | null;
  chequeBankName: string | null;
  chequeDate: Date | null;
  amount: number;
  status: ChequeStatus | null;
  customer: Ref | null;
  collectedBy: { id: string | null; name: string | null };
  depositedInto: Ref | null;
  clearedInto: Ref | null;
  returnReason: string | null;
  commentCount: number;
}

export interface ChequeSummary {
  pendingCount: number;
  pendingTotal: number;
  /** Pending, cheque date within the next 7 days. */
  dueSoon: { count: number; total: number };
  /** Not yet deposited, cheque date already past. */
  overdue: { count: number; total: number };
  depositedPending: { count: number; total: number };
}

/**
 * The life of a cheque received on a cash receipt (paymentMethod cheque):
 * at_office -> deposited (status only) -> cleared (posts cheques in hand ->
 * destination), or returned (reverses the receipt, so the customer owes
 * again). An admin can undo the last step, reversing its postings. Each step
 * is one transaction with its "cheque" audit entry.
 */
@Injectable()
export class ChequeService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(CashReceipt.name) private readonly receiptModel: Model<CashReceiptDocument>,
    private readonly posting: VoucherPostingService,
    private readonly ledgerAccountService: LedgerAccountService,
    private readonly auditService: AuditService,
    private readonly commentsService: CommentsService,
    entityAccess: EntityAccessRegistry,
  ) {
    entityAccess.register(CHEQUE_ENTITY_TYPE, {
      exists: async (id, user) =>
        Boolean(
          await this.receiptModel
            .exists(withScope({ _id: id, paymentMethod: PaymentMethod.CHEQUE }, await this.posting.scopeFilter(user, DEF)))
            .exec(),
        ),
      canRead: (user) => hasPermission(user, Permission.CHEQUES_READ),
    });
  }

  async findAll(
    query: ChequeQueryDto,
    viewer?: Viewer,
  ): Promise<{ items: ChequeRow[]; page: number; pageSize: number; summary: ChequeSummary }> {
    const filter: Record<string, unknown> = { paymentMethod: PaymentMethod.CHEQUE, status: { $ne: VoucherStatus.CANCELLED } };
    if (query.status) filter.chequeStatus = query.status;
    if (query.dueFrom || query.dueTo) {
      filter.chequeDate = {
        ...(query.dueFrom ? { $gte: new Date(query.dueFrom) } : {}),
        ...(query.dueTo ? { $lte: endOfDay(new Date(query.dueTo)) } : {}),
      };
    }
    if (query.customerId) filter['lines.accountId'] = new Types.ObjectId(query.customerId);
    if (query.collectedBy) filter.collectedById = new Types.ObjectId(query.collectedBy);
    if (query.bank) filter.chequeBankName = new RegExp(escapeRegExp(query.bank.trim()), 'i');
    const term = query.q?.trim();
    if (term) {
      const pattern = new RegExp(escapeRegExp(term), 'i');
      filter.$or = [{ chequeNumber: pattern }, { chequeBankName: pattern }, { voucherNo: pattern }];
    }
    const scoped = withScope(filter, await this.posting.scopeFilter(viewer, DEF));
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const [docs, all] = await Promise.all([
      this.receiptModel
        .find(scoped)
        .sort({ chequeDate: 1, voucherNo: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean()
        .exec(),
      this.receiptModel.find(scoped).select('chequeStatus chequeDate grandTotal').lean().exec(),
    ]);
    const [names, comments] = await Promise.all([
      this.ledgerAccountService.getNames(docs.flatMap((doc) => (doc.lines[0] ? [doc.lines[0].accountId.toString()] : []))),
      this.commentsService.countByEntityIds(
        CHEQUE_ENTITY_TYPE,
        docs.map((doc) => doc._id),
      ),
    ]);
    const stepRef = (step: ChequeStep | null | undefined): Ref | null =>
      step?.accountId ? { id: step.accountId.toString(), name: step.accountName ?? null } : null;

    return {
      items: docs.map((doc) => {
        const customerId = doc.lines[0]?.accountId.toString();
        return {
          id: doc._id.toString(),
          voucherNo: doc.voucherNo,
          receiptDate: doc.voucherDate,
          chequeNumber: doc.chequeNumber ?? null,
          chequeBankName: doc.chequeBankName ?? null,
          chequeDate: doc.chequeDate ?? null,
          amount: doc.grandTotal,
          status: doc.chequeStatus ?? null,
          customer: customerId ? { id: customerId, name: names.get(customerId) ?? null } : null,
          collectedBy: { id: doc.collectedById?.toString() ?? null, name: doc.collectedByName ?? null },
          depositedInto: stepRef(doc.chequeDeposit),
          clearedInto: stepRef(doc.chequeClearance),
          returnReason: doc.chequeReturn?.reason ?? null,
          commentCount: comments.get(doc._id.toString()) ?? 0,
        };
      }),
      page,
      pageSize,
      summary: this.summarize(all),
    };
  }

  /** Status only: nothing is posted until the cheque clears. */
  async deposit(id: string, dto: DepositChequeDto, actor: Viewer): Promise<CashReceiptDocument> {
    const bank = await this.ledgerAccountService.findActiveReceiptAccount(dto.bankAccountId, [LedgerAccountType.BANK]);
    return this.step(id, actor, async (receipt) => {
      this.assertStatus(receipt, [ChequeStatus.AT_OFFICE], 'deposited');
      const date = new Date(dto.date);
      this.assertNotBeforeChequeDate(receipt, date, 'deposited');
      receipt.chequeDeposit = this.stepOf(date, actor, { accountId: bank._id, accountName: bank.name });
      return { action: AuditAction.DEPOSITED, to: ChequeStatus.DEPOSITED, detail: `Deposited into ${bank.name}` };
    });
  }

  /** Posts the cheque out of the receipt's cheques in hand account into the destination. */
  async clear(id: string, dto: ClearChequeDto, actor: Viewer): Promise<CashReceiptDocument> {
    const date = new Date(dto.date);
    if (date.getTime() > Date.now()) {
      throw new BadRequestException('A cheque cannot be cleared on a future date');
    }
    return this.step(id, actor, async (receipt, session) => {
      this.assertStatus(receipt, [ChequeStatus.AT_OFFICE, ChequeStatus.DEPOSITED], 'cleared');
      this.assertNotBeforeChequeDate(receipt, date, 'cleared');
      const destinationId = dto.destinationAccountId ?? receipt.chequeDeposit?.accountId?.toString();
      if (!destinationId) {
        throw new BadRequestException('Choose a destinationAccountId: the cheque was not deposited into a bank');
      }
      const destination = await this.ledgerAccountService.findActiveReceiptAccount(destinationId, CLEAR_INTO_TYPES);
      await this.posting.postTransfers(
        this.ref(receipt, date),
        [this.clearing(receipt, destination._id.toString())],
        LedgerEntryKind.POSTING,
        'cleared',
        session,
      );
      receipt.chequeClearance = this.stepOf(date, actor, { accountId: destination._id, accountName: destination.name });
      return { action: AuditAction.CLEARED, to: ChequeStatus.CLEARED, detail: `Cleared into ${destination.name}` };
    });
  }

  /** Bounced: the receipt's posting is reversed, so the customer owes again; the receipt stays, marked returned. */
  async return(id: string, dto: ReturnChequeDto, actor: Viewer): Promise<CashReceiptDocument> {
    return this.step(id, actor, async (receipt, session) => {
      this.assertStatus(receipt, [ChequeStatus.AT_OFFICE, ChequeStatus.DEPOSITED], 'returned');
      await this.posting.reverseDocument(DEF, receipt as unknown as VoucherDocument, 'cheque-returned', session);
      receipt.chequeReturn = this.stepOf(new Date(dto.date), actor, { reason: dto.reason });
      return { action: AuditAction.RETURNED, to: ChequeStatus.RETURNED, detail: dto.reason, reason: dto.reason };
    });
  }

  /** Admin only: undoes the last step (deposit, clearance or return), reversing what it posted. */
  async undo(id: string, dto: UndoChequeDto, actor: Viewer): Promise<CashReceiptDocument> {
    if (actor.role?.name !== ADMIN_ROLE_NAME) {
      throw new ForbiddenException('Only an administrator can undo a cheque step');
    }
    return this.step(id, actor, async (receipt, session) => {
      const back = receipt.chequeDeposit ? ChequeStatus.DEPOSITED : ChequeStatus.AT_OFFICE;
      switch (receipt.chequeStatus) {
        case ChequeStatus.DEPOSITED:
          receipt.chequeDeposit = null;
          return { action: AuditAction.UNDONE, to: ChequeStatus.AT_OFFICE, detail: 'Deposit undone', reason: dto.reason };
        case ChequeStatus.CLEARED: {
          const clearance = receipt.chequeClearance!;
          await this.posting.postTransfers(
            this.ref(receipt, clearance.date),
            [this.clearing(receipt, clearance.accountId!.toString())],
            LedgerEntryKind.REVERSAL,
            'clearance-undone',
            session,
          );
          receipt.chequeClearance = null;
          return { action: AuditAction.UNDONE, to: back, detail: 'Clearance undone', reason: dto.reason };
        }
        case ChequeStatus.RETURNED:
          await this.posting.postDocument(DEF, receipt as unknown as VoucherDocument, 'return-undone', session);
          receipt.chequeReturn = null;
          return { action: AuditAction.UNDONE, to: back, detail: 'Return undone', reason: dto.reason };
        default:
          throw new BadRequestException(`Cheque on ${receipt.voucherNo} is ${receipt.chequeStatus}: nothing to undo`);
      }
    });
  }

  /** Loads the cheque receipt in scope, applies `change`, saves the new status and audits it, in one transaction. */
  private async step(
    id: string,
    actor: Viewer,
    change: (
      receipt: CashReceiptDocument,
      session: ClientSession,
    ) => Promise<{ action: AuditAction; to: ChequeStatus; detail: string; reason?: string }>,
  ): Promise<CashReceiptDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Cheque id "${id}" is not a valid id`);
    }
    const scope = await this.posting.scopeFilter(actor, DEF);
    return runInTransaction(this.connection, async (session) => {
      const receipt = await this.receiptModel
        .findOne(withScope({ _id: new Types.ObjectId(id), paymentMethod: PaymentMethod.CHEQUE }, scope))
        .session(session)
        .exec();
      if (!receipt) {
        throw new NotFoundException(`Cheque ${id} not found`);
      }
      if (receipt.status === VoucherStatus.CANCELLED) {
        throw new BadRequestException(`${receipt.voucherNo} is cancelled`);
      }
      const from = receipt.chequeStatus;
      const result = await change(receipt, session);
      receipt.chequeStatus = result.to;
      await receipt.save({ session });
      await this.auditService.record(
        {
          entityType: CHEQUE_ENTITY_TYPE,
          entityId: receipt._id,
          entityRef: `${receipt.chequeNumber} (${receipt.voucherNo})`,
          action: result.action,
          actor,
          changes: [
            { field: 'chequeStatus', label: 'Status', from, to: result.to },
            { field: 'detail', label: 'Detail', from: null, to: result.detail },
          ],
          reason: result.reason,
        },
        session,
      );
      return receipt;
    });
  }

  private summarize(cheques: { chequeStatus?: ChequeStatus | null; chequeDate?: Date | null; grandTotal: number }[]): ChequeSummary {
    const today = startOfToday();
    const soon = new Date(today.getTime() + 8 * DAY_MS - 1);
    const pick = (test: (cheque: (typeof cheques)[number]) => boolean) => {
      const matching = cheques.filter(test);
      return { count: matching.length, total: round2(matching.reduce((sum, cheque) => sum + cheque.grandTotal, 0)) };
    };
    const isPending = (cheque: (typeof cheques)[number]) => PENDING.includes(cheque.chequeStatus!);
    const pending = pick(isPending);
    return {
      pendingCount: pending.count,
      pendingTotal: pending.total,
      dueSoon: pick((cheque) => isPending(cheque) && !!cheque.chequeDate && cheque.chequeDate >= today && cheque.chequeDate <= soon),
      overdue: pick(
        (cheque) => UNDEPOSITED.includes(cheque.chequeStatus!) && !!cheque.chequeDate && cheque.chequeDate < today,
      ),
      depositedPending: pick((cheque) => cheque.chequeStatus === ChequeStatus.DEPOSITED),
    };
  }

  private clearing(receipt: CashReceiptDocument, destinationId: string) {
    return {
      fromAccountId: receipt.cashAccountId.toString(),
      toAccountId: destinationId,
      amount: receipt.grandTotal,
      narration: `Cheque ${receipt.chequeNumber} (${receipt.voucherNo})`,
    };
  }

  private ref(receipt: CashReceiptDocument, date: Date) {
    return { entityType: CHEQUE_ENTITY_TYPE, id: receipt._id, voucherNo: receipt.voucherNo, voucherDate: date };
  }

  private stepOf(
    date: Date,
    actor: Actor,
    extra: { accountId?: Types.ObjectId; accountName?: string; reason?: string },
  ): ChequeStep {
    return {
      date,
      accountId: extra.accountId ?? null,
      accountName: extra.accountName ?? null,
      reason: extra.reason ?? null,
      by: toUserSnapshot(actor),
      at: new Date(),
    };
  }

  private assertStatus(receipt: CashReceiptDocument, allowed: readonly ChequeStatus[], action: string): void {
    if (!receipt.chequeStatus || !allowed.includes(receipt.chequeStatus)) {
      throw new BadRequestException(
        `Cheque on ${receipt.voucherNo} is ${receipt.chequeStatus}; only a ${allowed.join(' or ')} cheque can be ${action}`,
      );
    }
  }

  private assertNotBeforeChequeDate(receipt: CashReceiptDocument, date: Date, action: string): void {
    if (receipt.chequeDate && date < receipt.chequeDate) {
      throw new BadRequestException(
        `Cheque on ${receipt.voucherNo} is dated ${receipt.chequeDate.toISOString().slice(0, 10)} and cannot be ${action} before then`,
      );
    }
  }
}

function startOfToday(): Date {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return today;
}

function endOfDay(date: Date): Date {
  const end = new Date(date);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}
