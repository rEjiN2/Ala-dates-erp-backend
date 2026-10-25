import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Allocation, AllocationSchema } from './schemas/allocation.schema.js';
import { AllocationService } from './allocation.service.js';
import { AllocationController } from './allocation.controller.js';
import { PurchaseInvoice, PurchaseInvoiceSchema } from '../../purchase/purchase-invoices/schemas/purchase-invoice.schema.js';
import { SalesInvoice, SalesInvoiceSchema } from '../../sales/sales-invoices/schemas/sales-invoice.schema.js';
import { OpeningBalance, OpeningBalanceSchema } from '../opening-balances/schemas/opening-balance.schema.js';
import { Party, PartySchema } from '../../party/schemas/party.schema.js';
import { AuditModule } from '../../audit/audit.module.js';

/** Payments applied to bills. Uses bill models only, so voucher modules can import it without cycles. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Allocation.name, schema: AllocationSchema },
      { name: PurchaseInvoice.name, schema: PurchaseInvoiceSchema },
      { name: SalesInvoice.name, schema: SalesInvoiceSchema },
      { name: OpeningBalance.name, schema: OpeningBalanceSchema },
      { name: Party.name, schema: PartySchema },
    ]),
    AuditModule,
  ],
  controllers: [AllocationController],
  providers: [AllocationService],
  exports: [AllocationService],
})
export class AllocationModule {}
