import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { SalesReturn, type ReturnDocument } from './schemas/return.schema.js';
import { SALES_RETURN_DEFINITION as DEF } from './return-definition.js';
import { ReturnService, type ReturnModel } from './return.service.js';
import type { CancelReturnDto, CreateSalesReturnDto, ReturnQueryDto, UpdateSalesReturnDto } from './dto/return.dto.js';
import type { PrintedVoucher } from '../vouchers/voucher-print.service.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';

/**
 * Sales returns (credit notes): Dr Sales Returns + VAT Output, Cr customer,
 * goods back into stock. Every rule lives in ReturnService; this only maps
 * the sales field names (salesInvoiceId) onto it.
 */
@Injectable()
export class SalesReturnService {
  private readonly model: ReturnModel;

  constructor(
    @InjectModel(SalesReturn.name) salesReturnModel: Model<SalesReturn>,
    private readonly engine: ReturnService,
  ) {
    this.model = salesReturnModel as unknown as ReturnModel;
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

  create(dto: CreateSalesReturnDto, actor: AuthenticatedUser) {
    const { salesInvoiceId, ...rest } = dto;
    return this.engine.create(DEF, this.model, { ...rest, invoiceId: salesInvoiceId }, actor);
  }

  update(id: string, dto: UpdateSalesReturnDto, actor: AuthenticatedUser) {
    return this.engine.update(DEF, this.model, id, dto, actor);
  }

  cancel(id: string, dto: CancelReturnDto, actor: AuthenticatedUser) {
    return this.engine.cancel(DEF, this.model, id, dto.reason, actor);
  }

  /** CREDIT NOTE, ORIGINAL then DUPLICATEs; every call is audited as a print. */
  print(id: string, actor: AuthenticatedUser): Promise<PrintedVoucher> {
    return this.engine.print(DEF, this.model, id, actor);
  }
}
