import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CashReceipt, CashReceiptSchema } from '../accounting/cash-receipts/schemas/cash-receipt.schema.js';
import { CashHandover, CashHandoverSchema } from '../accounting/cash-handovers/schemas/cash-handover.schema.js';
import { User, UserSchema } from '../users/schemas/user.schema.js';
import { Location, LocationSchema } from '../location/schemas/location.schema.js';
import { LedgerAccountModule } from '../accounting/ledger-accounts/ledger-account.module.js';
import { LedgerEntry, LedgerEntrySchema } from '../accounting/vouchers/schemas/ledger-entry.schema.js';
import { LedgerAccount, LedgerAccountSchema } from '../accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { CompanyModule } from '../company/company.module.js';
import { AccountingReportsService } from './accounting-reports.service.js';
import { ReportService } from './report.service.js';
import { SalesmanCollectionsService } from './salesman-collections.service.js';
import { ReportsController } from './reports.controller.js';

/** Read-only reports over the voucher collections. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CashReceipt.name, schema: CashReceiptSchema },
      { name: CashHandover.name, schema: CashHandoverSchema },
      { name: User.name, schema: UserSchema },
      { name: Location.name, schema: LocationSchema },
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
      { name: LedgerAccount.name, schema: LedgerAccountSchema },
    ]),
    LedgerAccountModule,
    CompanyModule,
  ],
  controllers: [ReportsController],
  providers: [SalesmanCollectionsService, ReportService, AccountingReportsService],
})
export class ReportsModule {}
