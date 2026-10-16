import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { CashReceipt, CashReceiptDocument } from './schemas/cash-receipt.schema.js';
import { CreateCashReceiptDto } from './dto/create-cash-receipt.dto.js';
import { CancelCashReceiptDto, UpdateCashReceiptDto } from './dto/update-cash-receipt.dto.js';
import { CashReceiptQueryDto } from './dto/cash-receipt-query.dto.js';
import { CASH_RECEIPT_DEFINITION } from './cash-receipt.definition.js';
import {
  VoucherPostingService,
  type VoucherListRow,
  type VoucherModel,
  type VoucherPage,
} from '../vouchers/voucher-posting.service.js';
import type { Actor } from '../../../common/schemas/user-snapshot.schema.js';
import type { ScopedUser } from '../vouchers/data-scope.js';

/** The authenticated user; "own"-scoped users see and post only their own receipts. */
type Viewer = Actor & ScopedUser;

export { CASH_RECEIPT_VOUCHER_SEQUENCE, RECEIPT_LINE_ACCOUNT_TYPES } from './cash-receipt.definition.js';

export type CashReceiptListRow = Omit<VoucherListRow, 'header'> & { cashAccount: VoucherListRow['header'] };
export type CashReceiptPage = VoucherPage<CashReceiptListRow>;

/**
 * Cash/bank receipts. Every posting rule lives in VoucherPostingService;
 * this only maps the receipt's own field names (cashAccountId) onto it.
 */
@Injectable()
export class CashReceiptService {
  private readonly model: VoucherModel;

  constructor(
    @InjectModel(CashReceipt.name) cashReceiptModel: Model<CashReceiptDocument>,
    private readonly posting: VoucherPostingService,
  ) {
    this.model = cashReceiptModel as unknown as VoucherModel;
    posting.registerVoucherType(CASH_RECEIPT_DEFINITION, this.model);
  }

  async findAll(query: CashReceiptQueryDto = {}, viewer?: Viewer): Promise<CashReceiptPage> {
    const { cashAccountId, ...rest } = query;
    const page = await this.posting.list(
      CASH_RECEIPT_DEFINITION,
      this.model,
      { ...rest, headerAccountId: cashAccountId },
      viewer,
    );
    return { ...page, items: page.items.map(({ header, ...row }) => ({ ...row, cashAccount: header })) };
  }

  async findById(id: string, viewer?: Viewer): Promise<CashReceiptDocument> {
    return (await this.posting.findById(
      CASH_RECEIPT_DEFINITION,
      this.model,
      id,
      viewer,
    )) as unknown as CashReceiptDocument;
  }

  /** `actor` is the authenticated user; nothing in the DTO can set who created the receipt. */
  async create(dto: CreateCashReceiptDto, actor: Viewer): Promise<CashReceiptDocument> {
    const { cashAccountId, ...rest } = dto;
    return (await this.posting.create(
      CASH_RECEIPT_DEFINITION,
      this.model,
      { ...rest, headerAccountId: cashAccountId },
      actor,
    )) as unknown as CashReceiptDocument;
  }

  async update(id: string, dto: UpdateCashReceiptDto, actor: Viewer): Promise<CashReceiptDocument> {
    const { cashAccountId, ...rest } = dto;
    return (await this.posting.update(
      CASH_RECEIPT_DEFINITION,
      this.model,
      id,
      { ...rest, headerAccountId: cashAccountId },
      actor,
    )) as unknown as CashReceiptDocument;
  }

  /** Reverses the posting and keeps the receipt, marked cancelled, with who/when/why. */
  async cancel(id: string, dto: CancelCashReceiptDto, actor: Viewer): Promise<CashReceiptDocument> {
    return (await this.posting.cancel(
      CASH_RECEIPT_DEFINITION,
      this.model,
      id,
      dto?.reason,
      actor,
    )) as unknown as CashReceiptDocument;
  }

  async remove(id: string, viewer?: Viewer): Promise<{ success: true }> {
    return this.posting.remove(CASH_RECEIPT_DEFINITION, this.model, id, viewer);
  }
}
