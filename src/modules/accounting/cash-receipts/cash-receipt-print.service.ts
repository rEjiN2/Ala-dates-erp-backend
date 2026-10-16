import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { CashReceipt, CashReceiptDocument } from './schemas/cash-receipt.schema.js';
import { CASH_RECEIPT_DEFINITION } from './cash-receipt.definition.js';
import { VoucherPrintService, type PrintedVoucher } from '../vouchers/voucher-print.service.js';
import { VoucherPostingService, type VoucherModel } from '../vouchers/voucher-posting.service.js';
import type { ScopedUser } from '../vouchers/data-scope.js';
import type { Actor } from '../../../common/schemas/user-snapshot.schema.js';

export type PrintedCashReceipt = PrintedVoucher;

@Injectable()
export class CashReceiptPrintService {
  constructor(
    @InjectModel(CashReceipt.name) private readonly cashReceiptModel: Model<CashReceiptDocument>,
    private readonly printService: VoucherPrintService,
    private readonly posting: VoucherPostingService,
  ) {}

  /** CASH or BANK RECEIPT VOUCHER, ORIGINAL then DUPLICATEs; every call is audited as a print. */
  async print(id: string, actor: Actor & ScopedUser): Promise<PrintedCashReceipt> {
    return this.printService.print(
      CASH_RECEIPT_DEFINITION,
      this.cashReceiptModel as unknown as VoucherModel,
      id,
      actor,
      await this.posting.scopeFilter(actor),
    );
  }
}
