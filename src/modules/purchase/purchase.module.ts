import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PurchaseInvoice, PurchaseInvoiceSchema } from './purchase-invoices/schemas/purchase-invoice.schema.js';
import { PurchaseInvoiceService } from './purchase-invoices/purchase-invoice.service.js';
import { PurchaseInvoiceController } from './purchase-invoices/purchase-invoice.controller.js';
import { Product, ProductSchema } from '../product/products/schemas/product.schema.js';
import { Party, PartySchema } from '../party/schemas/party.schema.js';
import { Location, LocationSchema } from '../location/schemas/location.schema.js';
import { VouchersModule } from '../accounting/vouchers/vouchers.module.js';
import { LedgerAccountModule } from '../accounting/ledger-accounts/ledger-account.module.js';
import { StockModule } from '../stock/stock.module.js';
import { ProductsModule } from '../product/products/products.module.js';
import { CompanyModule } from '../company/company.module.js';
import { SequenceModule } from '../sequence/sequence.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { CommentsModule } from '../comments/comments.module.js';
import { AllocationModule } from '../accounting/allocations/allocation.module.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PurchaseInvoice.name, schema: PurchaseInvoiceSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Party.name, schema: PartySchema },
      { name: Location.name, schema: LocationSchema },
    ]),
    VouchersModule,
    LedgerAccountModule,
    StockModule,
    ProductsModule,
    CompanyModule,
    SequenceModule,
    AuditModule,
    CommentsModule,
    AllocationModule,
  ],
  controllers: [PurchaseInvoiceController],
  providers: [PurchaseInvoiceService],
})
export class PurchaseModule {}
