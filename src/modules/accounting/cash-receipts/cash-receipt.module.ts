import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CashReceipt, CashReceiptSchema } from './schemas/cash-receipt.schema.js';
import { CashReceiptService } from './cash-receipt.service.js';
import { CashReceiptController } from './cash-receipt.controller.js';
import { LedgerAccountModule } from '../ledger-accounts/ledger-account.module.js';
import { SequenceModule } from '../../sequence/sequence.module.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: CashReceipt.name, schema: CashReceiptSchema }]),
    LedgerAccountModule,
    SequenceModule,
  ],
  controllers: [CashReceiptController],
  providers: [CashReceiptService],
  exports: [CashReceiptService],
})
export class CashReceiptModule {}
