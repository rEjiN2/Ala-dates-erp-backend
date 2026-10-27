import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PurchaseReturn, PurchaseReturnSchema, SalesReturn, SalesReturnSchema } from './schemas/return.schema.js';
import { ReturnService } from './return.service.js';
import { SalesReturnService } from './sales-return.service.js';
import { PurchaseReturnService } from './purchase-return.service.js';
import { SalesReturnController } from './sales-return.controller.js';
import { PurchaseReturnController } from './purchase-return.controller.js';
import { PurchaseInvoice, PurchaseInvoiceSchema } from '../../purchase/purchase-invoices/schemas/purchase-invoice.schema.js';
import { SalesInvoice, SalesInvoiceSchema } from '../../sales/sales-invoices/schemas/sales-invoice.schema.js';
import { Product, ProductSchema } from '../../product/products/schemas/product.schema.js';
import { Party, PartySchema } from '../../party/schemas/party.schema.js';
import { Location, LocationSchema } from '../../location/schemas/location.schema.js';
import { VouchersModule } from '../vouchers/vouchers.module.js';
import { LedgerAccountModule } from '../ledger-accounts/ledger-account.module.js';
import { AllocationModule } from '../allocations/allocation.module.js';
import { StockModule } from '../../stock/stock.module.js';
import { CompanyModule } from '../../company/company.module.js';
import { SequenceModule } from '../../sequence/sequence.module.js';
import { AuditModule } from '../../audit/audit.module.js';
import { CommentsModule } from '../../comments/comments.module.js';

/** Sales and purchase returns (credit and debit notes) against invoices. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SalesReturn.name, schema: SalesReturnSchema },
      { name: PurchaseReturn.name, schema: PurchaseReturnSchema },
      { name: SalesInvoice.name, schema: SalesInvoiceSchema },
      { name: PurchaseInvoice.name, schema: PurchaseInvoiceSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Party.name, schema: PartySchema },
      { name: Location.name, schema: LocationSchema },
    ]),
    VouchersModule,
    LedgerAccountModule,
    AllocationModule,
    StockModule,
    CompanyModule,
    SequenceModule,
    AuditModule,
    CommentsModule,
  ],
  controllers: [SalesReturnController, PurchaseReturnController],
  providers: [ReturnService, SalesReturnService, PurchaseReturnService],
})
export class ReturnModule {}
