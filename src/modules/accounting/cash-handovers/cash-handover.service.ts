import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import { CashHandover, CashHandoverDocument } from './schemas/cash-handover.schema.js';
import {
  ApproveCashHandoverDto,
  CancelCashHandoverDto,
  CashHandoverQueryDto,
  CreateCashHandoverDto,
  RejectCashHandoverDto,
  UnsettledReceiptsQueryDto,
} from './dto/cash-handover.dto.js';
import { CASH_HANDOVER_DEFINITION, HANDOVER_SOURCE_ACCOUNT_TYPES } from './cash-handover.definition.js';
import {
  VoucherPostingService,
  type VoucherListRow,
  type VoucherModel,
  type VoucherPage,
} from '../vouchers/voucher-posting.service.js';
import { VoucherPrintService, type PrintedVoucher } from '../vouchers/voucher-print.service.js';
import {
  assertScopedHeaderAccount,
  isOwnScope,
  resolveScopedCashier,
  withScope,
  type ScopedUser,
} from '../vouchers/data-scope.js';
import { PaymentMethod, VoucherStatus, paymentMethodFor } from '../vouchers/schemas/voucher.schema.js';
import {
  CashReceipt,
  CashReceiptDocument,
  SettlementStatus,
} from '../cash-receipts/schemas/cash-receipt.schema.js';
import { LedgerAccountService } from '../ledger-accounts/ledger-account.service.js';
import { CashierService } from '../../cashier/cashier.service.js';
import { CashierUsageRegistry } from '../../cashier/cashier-usage.registry.js';
import { StaffType } from '../../cashier/schemas/cashier.schema.js';
import { CompanyService } from '../../company/company.service.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction, type AuditChange } from '../../audit/schemas/audit-log.schema.js';
import { Permission, hasPermission } from '../../roles/permissions.js';
import { type Actor, toUserSnapshot } from '../../../common/schemas/user-snapshot.schema.js';
import { round2, sum2 } from '../../../common/utils/money.util.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';

/** The authenticated user; "own"-scoped users see only their own staff record's handovers. */
type Viewer = Actor & ScopedUser & { permissions?: readonly string[] };

type Ref = { id: string; name: string | null };

const DEF = CASH_HANDOVER_DEFINITION;

export interface CashHandoverListRow
  extends Pick<
    VoucherListRow,
    'id' | 'voucherNo' | 'date' | 'status' | 'createdBy' | 'createdAt' | 'commentCount'
  > {
  staff: VoucherListRow['cashier'];
  sourceAccount: Ref;
  receivedInto: Ref | null;
  receiptCount: number;
  expectedCash: number;
  bankTotal: number;
  countedCash: number | null;
  receivedCash: number | null;
}

export type CashHandoverPage = VoucherPage<CashHandoverListRow>;

export interface UnsettledReceipt {
  id: string;
  voucherNo: string;
  date: Date;
  account: Ref;
  paymentMethod: PaymentMethod;
  amount: number;
}

/**
 * Staff who settle with the office hand over the receipts they collected:
 * submit (receipts locked) -> approve (received cash posted, receipts
 * settled) or reject (receipts unlocked). The submitter may cancel before
 * approval; cancelling an approved one needs cash-handovers:cancel and
 * reverses its posting. Every step is one transaction with its audit entry.
 */
@Injectable()
export class CashHandoverService {
  private readonly model: VoucherModel;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(CashHandover.name) private readonly handoverModel: Model<CashHandoverDocument>,
    @InjectModel(CashReceipt.name) private readonly receiptModel: Model<CashReceiptDocument>,
    private readonly posting: VoucherPostingService,
    private readonly printService: VoucherPrintService,
    private readonly ledgerAccountService: LedgerAccountService,
    private readonly cashierService: CashierService,
    private readonly companyService: CompanyService,
    private readonly sequenceService: SequenceService,
    private readonly auditService: AuditService,
    cashierUsage: CashierUsageRegistry,
  ) {
    this.model = handoverModel as unknown as VoucherModel;
    posting.registerVoucherType(DEF, this.model);
    // Handovers from before approval name the cashier who received the money.
    cashierUsage.register('cash handovers (as receiver)', async (cashierId, session) =>
      Boolean(
        await this.handoverModel
          .exists({ receivedByCashierId: cashierId })
          .session(session ?? null)
          .exec(),
      ),
    );
  }

  async findAll(query: CashHandoverQueryDto = {}, viewer?: Viewer): Promise<CashHandoverPage> {
    const { sourceAccountId, staffId, handoverStatus, ...rest } = query;
    const page = await this.posting.list(
      DEF,
      this.model,
      { ...rest, headerAccountId: sourceAccountId, cashierId: staffId ?? rest.cashierId },
      viewer,
      handoverStatus ? { status: handoverStatus } : null,
    );

    const docs = await this.handoverModel
      .find({ _id: { $in: page.items.map((row) => new Types.ObjectId(row.id)) } })
      .select('receipts expectedCash bankTotal countedCash receivedCash receivedIntoAccountId receivedIntoAccountName')
      .lean()
      .exec();
    const byId = new Map(docs.map((doc) => [doc._id.toString(), doc]));

    return {
      ...page,
      items: page.items.map((row) => {
        const doc = byId.get(row.id);
        return {
          id: row.id,
          voucherNo: row.voucherNo,
          date: row.date,
          staff: row.cashier,
          sourceAccount: row.header,
          receivedInto: doc?.receivedIntoAccountId
            ? { id: doc.receivedIntoAccountId.toString(), name: doc.receivedIntoAccountName ?? null }
            : null,
          receiptCount: doc?.receipts?.length ?? 0,
          expectedCash: doc?.expectedCash ?? 0,
          bankTotal: doc?.bankTotal ?? 0,
          countedCash: doc?.countedCash ?? null,
          receivedCash: doc?.receivedCash ?? null,
          status: row.status,
          createdBy: row.createdBy,
          createdAt: row.createdAt,
          commentCount: row.commentCount,
        };
      }),
    };
  }

  async findById(id: string, viewer?: Viewer): Promise<CashHandoverDocument> {
    return (await this.posting.findById(DEF, this.model, id, viewer)) as unknown as CashHandoverDocument;
  }

  /** The staff member's receipts not yet on a handover, oldest first: what a new handover can include. */
  async unsettled(query: UnsettledReceiptsQueryDto, viewer: Viewer): Promise<{
    receipts: UnsettledReceipt[];
    totals: { cash: number; bank: number };
  }> {
    const staffId = await this.staffIdFor(query.staffId, viewer);
    const receipts = await this.receiptModel
      .find({
        cashierId: new Types.ObjectId(staffId),
        settlementStatus: SettlementStatus.UNSETTLED,
        status: { $ne: VoucherStatus.CANCELLED },
      })
      .sort({ voucherDate: 1, voucherNo: 1 })
      .lean()
      .exec();
    const names = await this.ledgerAccountService.getNames(receipts.map((receipt) => receipt.cashAccountId.toString()));
    const rows = receipts.map((receipt) => ({
      id: receipt._id.toString(),
      voucherNo: receipt.voucherNo,
      date: receipt.voucherDate,
      account: { id: receipt.cashAccountId.toString(), name: names.get(receipt.cashAccountId.toString()) ?? null },
      paymentMethod: receipt.paymentMethod ?? PaymentMethod.CASH,
      amount: receipt.grandTotal,
    }));
    const isBank = (row: UnsettledReceipt) => row.paymentMethod === PaymentMethod.BANK;
    return {
      receipts: rows,
      totals: {
        cash: sum2(rows.filter((row) => !isBank(row)).map((row) => row.amount)),
        bank: sum2(rows.filter(isBank).map((row) => row.amount)),
      },
    };
  }

  /**
   * Submits the receipts and locks them. Cash and wallet receipts must all be
   * in the source account; bank ones are listed for verification only.
   */
  async create(dto: CreateCashHandoverDto, actor: Viewer): Promise<CashHandoverDocument> {
    const staffId = await this.staffIdFor(dto.staffId, actor);
    if (isOwnScope(actor)) {
      assertScopedHeaderAccount(actor, dto.sourceAccountId, DEF.label);
    }
    const source = await this.ledgerAccountService.findActiveReceiptAccount(dto.sourceAccountId);
    if (!HANDOVER_SOURCE_ACCOUNT_TYPES.includes(source.type)) {
      throw new BadRequestException(
        `${source.code} (${source.name}) is a ${source.type} account. The source must be a cash or wallet account.`,
      );
    }
    const receiptIds = dto.receiptIds.map((id) => new Types.ObjectId(id));

    return runInTransaction(this.connection, async (session) => {
      const staff = await this.cashierService.findActiveForPosting(staffId, session);
      if (!staff.settlesWithOffice) {
        throw new BadRequestException(`${staff.code} (${staff.name}) does not settle cash with the office`);
      }
      const receipts = await this.receiptModel
        .find({
          _id: { $in: receiptIds },
          cashierId: staff._id,
          settlementStatus: SettlementStatus.UNSETTLED,
          status: { $ne: VoucherStatus.CANCELLED },
        })
        .session(session)
        .exec();
      const found = new Set(receipts.map((receipt) => receipt._id.toString()));
      const missing = dto.receiptIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(
          `These receipts are not unsettled receipts of ${staff.code} (${staff.name}): ${missing.join(', ')}`,
        );
      }
      const isBank = (receipt: CashReceiptDocument) => receipt.paymentMethod === PaymentMethod.BANK;
      const elsewhere = receipts.filter((receipt) => !isBank(receipt) && receipt.cashAccountId.toString() !== dto.sourceAccountId);
      if (elsewhere.length > 0) {
        throw new BadRequestException(
          `Cash receipts ${elsewhere.map((receipt) => receipt.voucherNo).join(', ')} were not received into ${source.code} (${source.name})`,
        );
      }

      const voucherNo = await this.sequenceService.nextCode(DEF.sequence, session);
      const now = new Date();
      const [created] = await this.handoverModel.create(
        [
          {
            voucherNo,
            voucherDate: new Date(dto.voucherDate),
            fromAccountId: source._id,
            cashierId: staff._id,
            cashierName: staff.name,
            cashierStaffType: staff.staffType ?? StaffType.CASHIER,
            paymentMethod: PaymentMethod.CASH,
            comments: dto.notes,
            lines: [],
            receipts: receipts
              .sort((a, b) => a.voucherDate.getTime() - b.voucherDate.getTime() || a.voucherNo.localeCompare(b.voucherNo))
              .map((receipt) => ({
                receiptId: receipt._id,
                voucherNo: receipt.voucherNo,
                voucherDate: receipt.voucherDate,
                paymentMethod: receipt.paymentMethod ?? PaymentMethod.CASH,
                amount: receipt.grandTotal,
              })),
            expectedCash: sum2(receipts.filter((receipt) => !isBank(receipt)).map((receipt) => receipt.grandTotal)),
            bankTotal: sum2(receipts.filter(isBank).map((receipt) => receipt.grandTotal)),
            countedCash: round2(dto.countedCash),
            status: VoucherStatus.SUBMITTED,
            createdBy: toUserSnapshot(actor),
            createdAt: now,
          },
        ],
        { session },
      );
      await this.moveReceipts(
        { _id: { $in: receiptIds }, settlementStatus: SettlementStatus.UNSETTLED },
        { settlementStatus: SettlementStatus.SUBMITTED, handoverId: created._id },
        receiptIds.length,
        session,
      );
      await this.record(created, AuditAction.CREATED, actor, now, session);
      return created;
    });
  }

  /**
   * Received = expected is fine; less needs varianceReason (the shortage stays
   * in the source account); more is refused. Posts receivedCash only, settles
   * every receipt (bank ones count as verified).
   */
  async approve(id: string, dto: ApproveCashHandoverDto, actor: Viewer): Promise<CashHandoverDocument> {
    this.assertValidId(id);
    const receivingAccount = await this.ledgerAccountService.findActiveReceiptAccount(dto.receivedIntoAccountId);
    const { allowSelfApproval } = await this.companyService.ensure();
    const scope = await this.posting.scopeFilter(actor, DEF);

    return runInTransaction(this.connection, async (session) => {
      const handover = await this.load(id, scope, session);
      this.assertStatus(handover, VoucherStatus.SUBMITTED, 'approved');
      if (!allowSelfApproval && handover.createdBy?.id.toString() === actor.id) {
        throw new ForbiddenException('You submitted this handover, so someone else must approve it');
      }
      if (receivingAccount._id.equals(handover.fromAccountId)) {
        throw new BadRequestException('The receiving account must be different from the source account');
      }
      const receivedCash = round2(dto.receivedCash);
      if (receivedCash > handover.expectedCash) {
        throw new BadRequestException(
          `Received cash ${receivedCash.toFixed(2)} is more than the expected ${handover.expectedCash.toFixed(2)}`,
        );
      }
      const short = receivedCash < handover.expectedCash;
      if (short && !dto.varianceReason) {
        throw new BadRequestException(
          `Received cash is ${round2(handover.expectedCash - receivedCash).toFixed(2)} short: a varianceReason is required`,
        );
      }

      const now = new Date();
      if (receivedCash > 0) {
        const balances = await this.ledgerAccountService.getBalances([receivingAccount._id.toString()], session);
        handover.lines = [
          {
            accountId: receivingAccount._id,
            narration: `Handover ${handover.voucherNo}`,
            oldBalance: balances.get(receivingAccount._id.toString()) ?? 0,
            amount: receivedCash,
            vat: 0,
            netAmount: receivedCash,
          },
        ];
      }
      handover.grossTotal = receivedCash;
      handover.totalTax = 0;
      handover.grandTotal = receivedCash;
      handover.paymentMethod = paymentMethodFor(receivingAccount.type);
      handover.receivedCash = receivedCash;
      handover.receivedIntoAccountId = receivingAccount._id;
      handover.receivedIntoAccountName = receivingAccount.name;
      handover.varianceReason = short ? dto.varianceReason! : null;
      handover.status = VoucherStatus.APPROVED;
      handover.approvedBy = toUserSnapshot(actor);
      handover.approvedAt = now;
      await handover.save({ session });

      await this.posting.postDocument(DEF, handover as never, 'approved', session);
      await this.moveReceipts(
        { handoverId: handover._id, settlementStatus: SettlementStatus.SUBMITTED },
        { settlementStatus: SettlementStatus.SETTLED, settledAt: now },
        handover.receipts.length,
        session,
      );
      await this.record(handover, AuditAction.APPROVED, actor, now, session, {
        changes: [
          this.statusChange(VoucherStatus.SUBMITTED, VoucherStatus.APPROVED),
          { field: 'receivedCash', label: 'Received cash', from: null, to: receivedCash.toFixed(2) },
          { field: 'receivedInto', label: 'Received into', from: null, to: receivingAccount.name },
        ],
        reason: handover.varianceReason ?? undefined,
      });
      return handover;
    });
  }

  /** Nothing was posted: the receipts go back to unsettled. */
  async reject(id: string, dto: RejectCashHandoverDto, actor: Viewer): Promise<CashHandoverDocument> {
    this.assertValidId(id);
    const reason = dto.reason.trim();
    const scope = await this.posting.scopeFilter(actor, DEF);

    return runInTransaction(this.connection, async (session) => {
      const handover = await this.load(id, scope, session);
      this.assertStatus(handover, VoucherStatus.SUBMITTED, 'rejected');
      const now = new Date();
      handover.status = VoucherStatus.REJECTED;
      handover.rejectedBy = toUserSnapshot(actor);
      handover.rejectedAt = now;
      handover.rejectReason = reason;
      await handover.save({ session });
      await this.releaseReceipts(handover, SettlementStatus.SUBMITTED, session);
      await this.record(handover, AuditAction.REJECTED, actor, now, session, {
        changes: [this.statusChange(VoucherStatus.SUBMITTED, VoucherStatus.REJECTED)],
        reason,
      });
      return handover;
    });
  }

  /**
   * Submitted: by its submitter, or anyone with cash-handovers:cancel; the
   * receipts are unlocked. Approved: cash-handovers:cancel only; the posting
   * is reversed and the receipts go back to unsettled.
   */
  async cancel(id: string, dto: CancelCashHandoverDto, actor: Viewer): Promise<CashHandoverDocument> {
    this.assertValidId(id);
    const reason = dto.reason.trim();
    const scope = await this.posting.scopeFilter(actor, DEF);
    const canCancelAny = hasPermission(actor, Permission.CASH_HANDOVERS_CANCEL);

    return runInTransaction(this.connection, async (session) => {
      const handover = await this.load(id, scope, session);
      const from = handover.status;
      if (from === VoucherStatus.SUBMITTED) {
        if (!canCancelAny && handover.createdBy?.id.toString() !== actor.id) {
          throw new ForbiddenException('Only the submitter, or a user who may cancel handovers, can cancel it');
        }
        await this.releaseReceipts(handover, SettlementStatus.SUBMITTED, session);
      } else if (from === VoucherStatus.APPROVED) {
        if (!canCancelAny) {
          throw new ForbiddenException('Cancelling an approved handover needs the cash-handovers:cancel permission');
        }
        await this.posting.reverseDocument(DEF, handover as never, 'cancelled', session);
        await this.releaseReceipts(handover, SettlementStatus.SETTLED, session);
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

  /** "own"-scoped users always act for their linked staff; others must name one. */
  private async staffIdFor(requested: string | undefined, viewer: Viewer): Promise<string> {
    if (isOwnScope(viewer)) {
      const linked = await this.cashierService.findByLinkedUser(viewer.id);
      return resolveScopedCashier(
        linked ? { id: linked.id as string, code: linked.code, name: linked.name } : null,
        requested,
        DEF.label,
      );
    }
    if (!requested) {
      throw new BadRequestException('staffId is required');
    }
    return requested;
  }

  private async load(id: string, scope: Record<string, unknown> | null, session: ClientSession) {
    const handover = await this.handoverModel
      .findOne(withScope({ _id: new Types.ObjectId(id) }, scope))
      .session(session)
      .exec();
    if (!handover) {
      throw new NotFoundException(`${DEF.label} ${id} not found`);
    }
    return handover;
  }

  /** Moves exactly `expected` receipts; fewer means one changed under us, and the whole step aborts. */
  private async moveReceipts(
    filter: Record<string, unknown>,
    set: Record<string, unknown>,
    expected: number,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.receiptModel.updateMany(filter, { $set: set }, { session }).exec();
    if (result.modifiedCount !== expected) {
      throw new ConflictException('Some receipts on this handover changed meanwhile; reload and try again');
    }
  }

  private async releaseReceipts(handover: CashHandoverDocument, from: SettlementStatus, session: ClientSession) {
    await this.moveReceipts(
      { handoverId: handover._id, settlementStatus: from },
      { settlementStatus: SettlementStatus.UNSETTLED, handoverId: null, settledAt: null },
      handover.receipts.length,
      session,
    );
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

  private assertValidId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`${DEF.label} id "${id}" is not a valid id`);
    }
  }
}
