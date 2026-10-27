import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { PurchaseReturn, type ReturnDocument } from './schemas/return.schema.js';
import { PURCHASE_RETURN_DEFINITION as DEF } from './return-definition.js';
import { ReturnService, type ReturnModel } from './return.service.js';
import type {
  CancelReturnDto,
  RefundReturnDto,
  CreatePurchaseReturnDto,
  ReturnQueryDto,
  UpdatePurchaseReturnDto,
} from './dto/return.dto.js';
import type { PrintedVoucher } from '../vouchers/voucher-print.service.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';

/**
 * Purchase returns (debit notes): Dr supplier, Cr Purchase Returns + VAT
 * Input, goods out of stock. Every rule lives in ReturnService; this only
 * maps the purchase field names (purchaseInvoiceId) onto it.
 */
@Injectable()
export class PurchaseReturnService {
  private readonly model: ReturnModel;

  constructor(
    @InjectModel(PurchaseReturn.name) purchaseReturnModel: Model<PurchaseReturn>,
    private readonly engine: ReturnService,
  ) {
    this.model = purchaseReturnModel as unknown as ReturnModel;
    engine.registerReturnType(DEF, this.model);
  }

  findAll(query: ReturnQueryDto, viewer: AuthenticatedUser) {
    return this.engine.findAll(DEF, this.model, query, viewer);
  }

  detail(id: string, viewer: AuthenticatedUser) {
    return this.engine.detail(DEF, this.model, id, viewer);
  }

  view(doc: ReturnDocument, viewer: AuthenticatedUser) {
    return this.engine.view(DEF, doc, viewer);
  }

  create(dto: CreatePurchaseReturnDto, actor: AuthenticatedUser) {
    const { purchaseInvoiceId, ...rest } = dto;
    return this.engine.create(DEF, this.model, { ...rest, invoiceId: purchaseInvoiceId }, actor);
  }

  update(id: string, dto: UpdatePurchaseReturnDto, actor: AuthenticatedUser) {
    return this.engine.update(DEF, this.model, id, dto, actor);
  }

  cancel(id: string, dto: CancelReturnDto, actor: AuthenticatedUser) {
    return this.engine.cancel(DEF, this.model, id, dto.reason, actor);
  }

  refund(id: string, dto: RefundReturnDto, actor: AuthenticatedUser) {
    return this.engine.refund(DEF, this.model, id, dto, actor);
  }

  cancelRefund(id: string, voucherId: string, dto: CancelReturnDto, actor: AuthenticatedUser) {
    return this.engine.cancelRefund(DEF, this.model, id, voucherId, dto.reason, actor);
  }

  /** DEBIT NOTE, ORIGINAL then DUPLICATEs; every call is audited as a print. */
  print(id: string, actor: AuthenticatedUser): Promise<PrintedVoucher> {
    return this.engine.print(DEF, this.model, id, actor);
  }
}
