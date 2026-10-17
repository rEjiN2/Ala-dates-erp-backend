import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CashReceipt, CashReceiptSchema } from '../accounting/cash-receipts/schemas/cash-receipt.schema.js';
import { CashHandover, CashHandoverSchema } from '../accounting/cash-handovers/schemas/cash-handover.schema.js';
import { Cashier, CashierSchema } from '../cashier/schemas/cashier.schema.js';
import { Location, LocationSchema } from '../location/schemas/location.schema.js';
import { LedgerAccountModule } from '../accounting/ledger-accounts/ledger-account.module.js';
import { SalesmanCollectionsService } from './salesman-collections.service.js';
import { ReportsController } from './reports.controller.js';

/** Read-only reports over the voucher collections. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CashReceipt.name, schema: CashReceiptSchema },
      { name: CashHandover.name, schema: CashHandoverSchema },
      { name: Cashier.name, schema: CashierSchema },
      { name: Location.name, schema: LocationSchema },
    ]),
    LedgerAccountModule,
  ],
  controllers: [ReportsController],
  providers: [SalesmanCollectionsService],
})
export class ReportsModule {}
