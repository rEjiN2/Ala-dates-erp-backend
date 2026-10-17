import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { CashHandover, CashHandoverDocument } from './schemas/cash-handover.schema.js';
import {
  CancelCashHandoverDto,
  CashHandoverQueryDto,
  CreateCashHandoverDto,
  UpdateCashHandoverDto,
} from './dto/cash-handover.dto.js';
import { CASH_HANDOVER_DEFINITION } from './cash-handover.definition.js';
import {
  VoucherPostingService,
  type VoucherListRow,
  type VoucherModel,
  type VoucherPage,
} from '../vouchers/voucher-posting.service.js';
import { VoucherPrintService, type PrintedVoucher } from '../vouchers/voucher-print.service.js';
import { isOwnScope, type ScopedUser } from '../vouchers/data-scope.js';
import { LedgerAccountService } from '../ledger-accounts/ledger-account.service.js';
import { CashierService } from '../../cashier/cashier.service.js';
import { CashierUsageRegistry } from '../../cashier/cashier-usage.registry.js';
import type { AuditChange } from '../../audit/schemas/audit-log.schema.js';
import type { Actor } from '../../../common/schemas/user-snapshot.schema.js';

/** The authenticated user; "own"-scoped users see only handovers their cashier handed over. */
type Viewer = Actor & ScopedUser;

type Ref = { id: string; name: string | null };

export interface CashHandoverListRow
  extends Pick<
    VoucherListRow,
    'id' | 'voucherNo' | 'date' | 'paymentMethod' | 'status' | 'createdBy' | 'createdAt' | 'updatedBy' | 'updatedAt' | 'commentCount'
  > {
  fromAccount: Ref;
  toAccount: Ref | null;
  handedBy: { id: string | null; name: string | null };
  receivedBy: Ref | null;
  amount: number;
}

export type CashHandoverPage = VoucherPage<CashHandoverListRow>;

/**
 * Cash handovers between cashiers. Posting, edit by reversal, cancel, audit,
 * comments and the PDF are VoucherPostingService's; this maps the handover's
 * fields onto it (from = header, to = the single line, handed by = cashier)
 * and owns the "received by" cashier.
 */
@Injectable()
export class CashHandoverService {
  private readonly model: VoucherModel;

  constructor(
    @InjectModel(CashHandover.name) private readonly handoverModel: Model<CashHandoverDocument>,
    private readonly posting: VoucherPostingService,
    private readonly printService: VoucherPrintService,
    private readonly ledgerAccountService: LedgerAccountService,
    private readonly cashierService: CashierService,
    cashierUsage: CashierUsageRegistry,
  ) {
    this.model = handoverModel as unknown as VoucherModel;
    posting.registerVoucherType(CASH_HANDOVER_DEFINITION, this.model);
    // The handing-over cashier is checked by registerVoucherType; the receiver is a reference too.
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
    const { fromAccountId, toAccountId, handedByCashierId, receivedByCashierId, ...rest } = query;
    const page = await this.posting.list(
      CASH_HANDOVER_DEFINITION,
      this.model,
      {
        ...rest,
        headerAccountId: fromAccountId,
        accountId: toAccountId ?? rest.accountId,
        cashierId: handedByCashierId ?? rest.cashierId,
      },
      viewer,
      receivedByCashierId ? { receivedByCashierId: new Types.ObjectId(receivedByCashierId) } : null,
    );

    const receivers = await this.handoverModel
      .find({ _id: { $in: page.items.map((row) => new Types.ObjectId(row.id)) } })
      .select('receivedByCashierId receivedByCashierName')
      .lean()
      .exec();
    const receiverOf = new Map(
      receivers.map((doc) => [
        doc._id.toString(),
        { id: doc.receivedByCashierId.toString(), name: doc.receivedByCashierName ?? null },
      ]),
    );

    return {
      ...page,
      items: page.items.map((row) => ({
        id: row.id,
        voucherNo: row.voucherNo,
        date: row.date,
        fromAccount: row.header,
        toAccount: row.partiesSummary.firstAccount,
        handedBy: row.cashier,
        receivedBy: receiverOf.get(row.id) ?? null,
        amount: row.grandTotal,
        paymentMethod: row.paymentMethod,
        status: row.status,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt,
        commentCount: row.commentCount,
      })),
    };
  }

  async findById(id: string, viewer?: Viewer): Promise<CashHandoverDocument> {
    return (await this.posting.findById(
      CASH_HANDOVER_DEFINITION,
      this.model,
      id,
      viewer,
    )) as unknown as CashHandoverDocument;
  }

  /**
   * Rejects with 409 and a `warnings` list when the handover would take a
   * cash or wallet "from" account below zero, unless acknowledgeWarnings is true.
   */
  async create(dto: CreateCashHandoverDto, actor: Viewer): Promise<CashHandoverDocument> {
    if (!dto.handedByCashierId && !isOwnScope(actor)) {
      throw new BadRequestException('handedByCashierId is required');
    }
    this.assertDifferentAccounts(dto.fromAccountId, dto.toAccountId);
    await this.ledgerAccountService.findActiveReceiptAccount(dto.toAccountId);
    const handedById = dto.handedByCashierId ?? (await this.linkedCashierId(actor));
    this.assertDifferentCashiers(handedById, dto.receivedByCashierId);
    const receiver = await this.cashierService.findActiveForPosting(dto.receivedByCashierId);

    return (await this.posting.create(
      CASH_HANDOVER_DEFINITION,
      this.model,
      {
        voucherDate: dto.voucherDate,
        headerAccountId: dto.fromAccountId,
        cashierId: dto.handedByCashierId,
        paymentReference: dto.reference ?? null,
        comments: dto.notes,
        lines: [{ accountId: dto.toAccountId, amount: dto.amount }],
        acknowledgeWarnings: dto.acknowledgeWarnings,
        extraFields: { receivedByCashierId: receiver._id, receivedByCashierName: receiver.name },
      },
      actor,
    )) as unknown as CashHandoverDocument;
  }

  /** Edit by reversal, as on payments; a no-change edit is rejected. */
  async update(id: string, dto: UpdateCashHandoverDto, actor: Viewer): Promise<CashHandoverDocument> {
    const current = await this.findById(id, actor);
    const currentLine = current.lines[0];
    const currentToId = currentLine.accountId.toString();
    const nextFromId = dto.fromAccountId ?? current.fromAccountId.toString();
    const nextToId = dto.toAccountId ?? currentToId;
    this.assertDifferentAccounts(nextFromId, nextToId);
    if (nextToId !== currentToId) {
      await this.ledgerAccountService.findActiveReceiptAccount(nextToId);
    }

    const currentReceiverId = current.receivedByCashierId.toString();
    const nextReceiverId = dto.receivedByCashierId ?? currentReceiverId;
    this.assertDifferentCashiers(dto.handedByCashierId ?? current.cashierId?.toString(), nextReceiverId);

    let extraFields: Record<string, unknown> | undefined;
    const extraChanges: AuditChange[] = [];
    if (nextReceiverId !== currentReceiverId) {
      const receiver = await this.cashierService.findActiveForPosting(nextReceiverId);
      extraFields = { receivedByCashierId: receiver._id, receivedByCashierName: receiver.name };
      extraChanges.push({
        field: 'receivedByCashier',
        label: 'Received by',
        from: current.receivedByCashierName,
        to: receiver.name,
      });
    }

    const linesChanged = dto.toAccountId !== undefined || dto.amount !== undefined;
    return (await this.posting.update(
      CASH_HANDOVER_DEFINITION,
      this.model,
      id,
      {
        voucherDate: dto.voucherDate,
        headerAccountId: dto.fromAccountId,
        cashierId: dto.handedByCashierId,
        paymentReference: dto.reference,
        comments: dto.notes,
        lines: linesChanged ? [{ accountId: nextToId, amount: dto.amount ?? currentLine.amount }] : undefined,
        changeNote: dto.changeNote,
        acknowledgeWarnings: dto.acknowledgeWarnings,
        extraFields,
        extraChanges,
      },
      actor,
    )) as unknown as CashHandoverDocument;
  }

  /** Reverses the posting and keeps the handover, marked cancelled, with who/when/why. */
  async cancel(id: string, dto: CancelCashHandoverDto, actor: Viewer): Promise<CashHandoverDocument> {
    return (await this.posting.cancel(
      CASH_HANDOVER_DEFINITION,
      this.model,
      id,
      dto?.reason,
      actor,
    )) as unknown as CashHandoverDocument;
  }

  /** CASH HANDOVER VOUCHER, ORIGINAL then DUPLICATEs; every call is audited as a print. */
  async print(id: string, actor: Viewer): Promise<PrintedVoucher> {
    return this.printService.print(
      CASH_HANDOVER_DEFINITION,
      this.model,
      id,
      actor,
      await this.posting.scopeFilter(actor, CASH_HANDOVER_DEFINITION),
    );
  }

  private async linkedCashierId(actor: Viewer): Promise<string | undefined> {
    return (await this.cashierService.findByLinkedUser(actor.id))?.id as string | undefined;
  }

  private assertDifferentAccounts(fromId: string, toId: string): void {
    if (fromId === toId) {
      throw new BadRequestException('The from and to accounts must be different');
    }
  }

  private assertDifferentCashiers(handedById: string | undefined, receivedById: string): void {
    if (handedById && handedById === receivedById) {
      throw new BadRequestException('The cashier receiving the money must be different from the one handing it over');
    }
  }
}
