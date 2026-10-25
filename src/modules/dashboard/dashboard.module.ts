import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LedgerAccountModule } from '../accounting/ledger-accounts/ledger-account.module.js';
import { DashboardService } from './dashboard.service.js';
import { DashboardController } from './dashboard.controller.js';
import { InvoiceTotalsService } from './invoice-totals.service.js';
import { SalesInvoice, SalesInvoiceSchema } from '../sales/sales-invoices/schemas/sales-invoice.schema.js';
import { PurchaseInvoice, PurchaseInvoiceSchema } from '../purchase/purchase-invoices/schemas/purchase-invoice.schema.js';

@Module({
  imports: [
    LedgerAccountModule,
    MongooseModule.forFeature([
      { name: SalesInvoice.name, schema: SalesInvoiceSchema },
      { name: PurchaseInvoice.name, schema: PurchaseInvoiceSchema },
    ]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService, InvoiceTotalsService],
})
export class DashboardModule {}
