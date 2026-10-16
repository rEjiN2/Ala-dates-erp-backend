import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { CashPayment, CashPaymentDocument } from './schemas/cash-payment.schema.js';
import {
  CancelCashPaymentDto,
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
  ) {
    this.model = cashPaymentModel as unknown as VoucherModel;
    posting.registerVoucherType(CASH_PAYMENT_DEFINITION, this.model);
  }

  async findAll(query: CashPaymentQueryDto = {}): Promise<CashPaymentPage> {
    const { paidFromAccountId, ...rest } = query;
    const page = await this.posting.list(CASH_PAYMENT_DEFINITION, this.model, {
      ...rest,
      headerAccountId: paidFromAccountId,
    });
    return { ...page, items: page.items.map(({ header, ...row }) => ({ ...row, paidFromAccount: header })) };
  }

  async findById(id: string): Promise<CashPaymentDocument> {
    return (await this.posting.findById(CASH_PAYMENT_DEFINITION, this.model, id)) as unknown as CashPaymentDocument;
  }

  /**
   * Rejects with 409 and a `warnings` list when the payment would take a
   * cash or wallet account below zero, unless acknowledgeWarnings is true.
   */
  async create(dto: CreateCashPaymentDto, actor: Actor): Promise<CashPaymentDocument> {
    const { paidFromAccountId, ...rest } = dto;
    return (await this.posting.create(
      CASH_PAYMENT_DEFINITION,
      this.model,
      { ...rest, headerAccountId: paidFromAccountId },
      actor,
    )) as unknown as CashPaymentDocument;
  }

  async update(id: string, dto: UpdateCashPaymentDto, actor: Actor): Promise<CashPaymentDocument> {
    const { paidFromAccountId, ...rest } = dto;
    return (await this.posting.update(
      CASH_PAYMENT_DEFINITION,
      this.model,
      id,
      { ...rest, headerAccountId: paidFromAccountId },
      actor,
    )) as unknown as CashPaymentDocument;
  }

  /** Reverses the posting and keeps the payment, marked cancelled, with who/when/why. */
  async cancel(id: string, dto: CancelCashPaymentDto, actor: Actor): Promise<CashPaymentDocument> {
    return (await this.posting.cancel(
      CASH_PAYMENT_DEFINITION,
      this.model,
      id,
      dto?.reason,
      actor,
    )) as unknown as CashPaymentDocument;
  }

  /** CASH or BANK PAYMENT VOUCHER, ORIGINAL then DUPLICATEs; every call is audited as a print. */
  print(id: string, actor: Actor): Promise<PrintedVoucher> {
    return this.printService.print(CASH_PAYMENT_DEFINITION, this.model, id, actor);
  }
}
