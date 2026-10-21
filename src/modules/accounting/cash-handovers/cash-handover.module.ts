import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CashHandover, CashHandoverSchema } from './schemas/cash-handover.schema.js';
import { CashReceipt, CashReceiptSchema } from '../cash-receipts/schemas/cash-receipt.schema.js';
import { CashPayment, CashPaymentSchema } from '../cash-payments/schemas/cash-payment.schema.js';
import { LedgerEntry, LedgerEntrySchema } from '../vouchers/schemas/ledger-entry.schema.js';
import { CashHandoverService } from './cash-handover.service.js';
import { CashHandoverController } from './cash-handover.controller.js';
import { VouchersModule } from '../vouchers/vouchers.module.js';
import { LedgerAccountModule } from '../ledger-accounts/ledger-account.module.js';
import { UsersModule } from '../../users/users.module.js';
import { CompanyModule } from '../../company/company.module.js';
import { CommentsModule } from '../../comments/comments.module.js';
import { SequenceModule } from '../../sequence/sequence.module.js';
import { AuditModule } from '../../audit/audit.module.js';
import { FilesModule } from '../../files/files.module.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CashHandover.name, schema: CashHandoverSchema },
      { name: CashReceipt.name, schema: CashReceiptSchema },
      { name: CashPayment.name, schema: CashPaymentSchema },
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
    ]),
    VouchersModule,
    LedgerAccountModule,
    UsersModule,
    CompanyModule,
    CommentsModule,
    SequenceModule,
    AuditModule,
    FilesModule,
  ],
  controllers: [CashHandoverController],
  providers: [CashHandoverService],
  exports: [CashHandoverService],
})
export class CashHandoverModule {}
