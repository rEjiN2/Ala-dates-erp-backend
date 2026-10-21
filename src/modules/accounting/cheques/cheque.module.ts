import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CashReceipt, CashReceiptSchema } from '../cash-receipts/schemas/cash-receipt.schema.js';
import { ChequeService } from './cheque.service.js';
import { ChequeController } from './cheque.controller.js';
import { VouchersModule } from '../vouchers/vouchers.module.js';
import { LedgerAccountModule } from '../ledger-accounts/ledger-account.module.js';
import { AuditModule } from '../../audit/audit.module.js';
import { CommentsModule } from '../../comments/comments.module.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: CashReceipt.name, schema: CashReceiptSchema }]),
    VouchersModule,
    LedgerAccountModule,
    AuditModule,
    CommentsModule,
  ],
  controllers: [ChequeController],
  providers: [ChequeService],
})
export class ChequeModule {}
