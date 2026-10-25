import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SalesInvoice, SalesInvoiceSchema } from './sales-invoices/schemas/sales-invoice.schema.js';
import { SalesInvoiceService } from './sales-invoices/sales-invoice.service.js';
import { SalesInvoiceController } from './sales-invoices/sales-invoice.controller.js';
import { Product, ProductSchema } from '../product/products/schemas/product.schema.js';
import { Party, PartySchema } from '../party/schemas/party.schema.js';
import { Location, LocationSchema } from '../location/schemas/location.schema.js';
import { CashReceipt, CashReceiptSchema } from '../accounting/cash-receipts/schemas/cash-receipt.schema.js';
import { VouchersModule } from '../accounting/vouchers/vouchers.module.js';
import { LedgerAccountModule } from '../accounting/ledger-accounts/ledger-account.module.js';
import { CashReceiptModule } from '../accounting/cash-receipts/cash-receipt.module.js';
import { AllocationModule } from '../accounting/allocations/allocation.module.js';
import { StockModule } from '../stock/stock.module.js';
import { ProductsModule } from '../product/products/products.module.js';
import { CompanyModule } from '../company/company.module.js';
import { SequenceModule } from '../sequence/sequence.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { CommentsModule } from '../comments/comments.module.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SalesInvoice.name, schema: SalesInvoiceSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Party.name, schema: PartySchema },
      { name: Location.name, schema: LocationSchema },
      { name: CashReceipt.name, schema: CashReceiptSchema },
    ]),
    VouchersModule,
    LedgerAccountModule,
    CashReceiptModule,
    AllocationModule,
    StockModule,
    ProductsModule,
    CompanyModule,
    SequenceModule,
    UsersModule,
    AuditModule,
    CommentsModule,
  ],
  controllers: [SalesInvoiceController],
  providers: [SalesInvoiceService],
})
export class SalesModule {}
