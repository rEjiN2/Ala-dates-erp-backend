import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { CashPayment, CashPaymentDocument } from './schemas/cash-payment.schema.js';
import {
  CancelCashPaymentDto,
  CashPaymentLineDto,
  CashPaymentQueryDto,
  CreateCashPaymentDto,
  UpdateCashPaymentDto,
} from './dto/cash-payment.dto.js';
import { CASH_PAYMENT_DEFINITION } from './cash-payment.definition.js';
import {
  VoucherPostingService,
  type VoucherListRow,
  type VoucherModel,
  type VoucherPage,
} from '../vouchers/voucher-posting.service.js';
import { VoucherPrintService, type PrintedVoucher } from '../vouchers/voucher-print.service.js';
import type { Actor } from '../../../common/schemas/user-snapshot.schema.js';
import type { ScopedUser } from '../vouchers/data-scope.js';
import type { VoucherUpdateInput } from '../vouchers/voucher-posting.service.js';
import { AllocationService, type LineAllocation } from '../allocations/allocation.service.js';
import { CASH_PAYMENT_ENTITY_TYPE } from './schemas/cash-payment.schema.js';
import { PartyKind } from '../../party/schemas/party.schema.js';

/** The authenticated user; "own"-scoped users see and post only their own payments. */
type Viewer = Actor & ScopedUser;

export type CashPaymentListRow = Omit<VoucherListRow, 'header'> & { paidFromAccount: VoucherListRow['header'] };
export type CashPaymentPage = VoucherPage<CashPaymentListRow>;

/**
 * Cash/bank payments. Every posting rule lives in VoucherPostingService;
 * this only maps the payment's own field names (paidFromAccountId) onto it.
 */
@Injectable()
export class CashPaymentService {
  private readonly model: VoucherModel;

  constructor(
    @InjectModel(CashPayment.name) cashPaymentModel: Model<CashPaymentDocument>,
    private readonly posting: VoucherPostingService,
    private readonly printService: VoucherPrintService,
    private readonly allocations: AllocationService,
  ) {
    this.model = cashPaymentModel as unknown as VoucherModel;
    posting.registerVoucherType(CASH_PAYMENT_DEFINITION, this.model);
    allocations.registerPaymentSource(CASH_PAYMENT_ENTITY_TYPE, this.model, PartyKind.SUPPLIER);
  }

  async findAll(query: CashPaymentQueryDto = {}, viewer?: Viewer): Promise<CashPaymentPage> {
    const { paidFromAccountId, ...rest } = query;
    const page = await this.posting.list(
      CASH_PAYMENT_DEFINITION,
      this.model,
      { ...rest, headerAccountId: paidFromAccountId },
      viewer,
    );
    return { ...page, items: page.items.map(({ header, ...row }) => ({ ...row, paidFromAccount: header })) };
  }

  async findById(id: string, viewer?: Viewer): Promise<CashPaymentDocument> {
    return (await this.posting.findById(
      CASH_PAYMENT_DEFINITION,
      this.model,
      id,
      viewer,
    )) as unknown as CashPaymentDocument;
  }

  /**
   * Rejects with 409 and a `warnings` list when the payment would take a
   * cash or wallet account below zero, unless acknowledgeWarnings is true.
   */
  async create(dto: CreateCashPaymentDto, actor: Viewer): Promise<CashPaymentDocument> {
    const { paidFromAccountId, lines, ...rest } = dto;
    const requests = allocationsOf(lines);
    return (await this.posting.create(
      CASH_PAYMENT_DEFINITION,
      this.model,
      {
        ...rest,
        headerAccountId: paidFromAccountId,
        lines: lines.map(withoutAllocations),
        afterPost: (voucher, session) =>
          this.allocations.allocateForPayment(CASH_PAYMENT_ENTITY_TYPE, voucher, requests, actor, session),
      },
      actor,
    )) as unknown as CashPaymentDocument;
  }

  /** Sending lines reverses the payment's allocations and reposts the ones on those lines. */
  async update(id: string, dto: UpdateCashPaymentDto, actor: Viewer): Promise<CashPaymentDocument> {
    const { paidFromAccountId, lines, ...rest } = dto;
    const input: VoucherUpdateInput = { ...rest, headerAccountId: paidFromAccountId };
    if (lines) {
      const requests = allocationsOf(lines);
      input.lines = lines.map(withoutAllocations);
      const [from, to] = await Promise.all([
        this.allocations.describePayment(CASH_PAYMENT_ENTITY_TYPE, id),
        this.allocations.describeRequests(requests),
      ]);
      if (from !== to) {
        input.extraChanges = [{ field: 'allocations', label: 'Allocations', from: from || null, to: to || null }];
      }
      input.afterPost = async (voucher, session) => {
        await this.allocations.reverseForPayment(CASH_PAYMENT_ENTITY_TYPE, voucher._id, 'Payment edited', actor, session);
        await this.allocations.allocateForPayment(CASH_PAYMENT_ENTITY_TYPE, voucher, requests, actor, session);
      };
    }
    return (await this.posting.update(CASH_PAYMENT_DEFINITION, this.model, id, input, actor)) as unknown as CashPaymentDocument;
  }

  /** Reverses the posting and keeps the payment, marked cancelled, with who/when/why. */
  async cancel(id: string, dto: CancelCashPaymentDto, actor: Viewer): Promise<CashPaymentDocument> {
    return (await this.posting.cancel(
      CASH_PAYMENT_DEFINITION,
      this.model,
      id,
      dto?.reason,
      actor,
      (voucher, reason, session) =>
        this.allocations.reverseForPayment(CASH_PAYMENT_ENTITY_TYPE, voucher._id, `Payment cancelled: ${reason}`, actor, session),
    )) as unknown as CashPaymentDocument;
  }

  /** CASH or BANK PAYMENT VOUCHER, ORIGINAL then DUPLICATEs; every call is audited as a print. */
  async print(id: string, actor: Viewer): Promise<PrintedVoucher> {
    return this.printService.print(
      CASH_PAYMENT_DEFINITION,
      this.model,
      id,
      actor,
      await this.posting.scopeFilter(actor, CASH_PAYMENT_DEFINITION),
    );
  }
}

function allocationsOf(lines: readonly CashPaymentLineDto[]): LineAllocation[] {
  return lines.flatMap((line, lineIndex) => (line.allocations ?? []).map((allocation) => ({ lineIndex, ...allocation })));
}

function withoutAllocations({ allocations: _allocations, ...line }: CashPaymentLineDto) {
  return line;
}
