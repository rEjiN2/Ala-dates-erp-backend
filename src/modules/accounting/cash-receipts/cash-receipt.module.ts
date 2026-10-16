import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CashReceipt, CashReceiptSchema } from './schemas/cash-receipt.schema.js';
import { CashReceiptService } from './cash-receipt.service.js';
import { CashReceiptPrintService } from './cash-receipt-print.service.js';
import { CashReceiptController } from './cash-receipt.controller.js';
import { LedgerAccountModule } from '../ledger-accounts/ledger-account.module.js';
import { SequenceModule } from '../../sequence/sequence.module.js';
import { AuditModule } from '../../audit/audit.module.js';
import { CommentsModule } from '../../comments/comments.module.js';
import { CashierModule } from '../../cashier/cashier.module.js';
import { CompanyModule } from '../../company/company.module.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: CashReceipt.name, schema: CashReceiptSchema }]),
    LedgerAccountModule,
    SequenceModule,
    AuditModule,
    CommentsModule,
    CashierModule,
    CompanyModule,
  ],
  controllers: [CashReceiptController],
  providers: [CashReceiptService, CashReceiptPrintService],
  exports: [CashReceiptService],
})
export class CashReceiptModule {}
