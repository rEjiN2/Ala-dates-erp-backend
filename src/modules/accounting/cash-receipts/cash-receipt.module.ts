import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CashReceipt, CashReceiptSchema } from './schemas/cash-receipt.schema.js';
import { CashReceiptService } from './cash-receipt.service.js';
import { CashReceiptPrintService } from './cash-receipt-print.service.js';
import { CashReceiptController } from './cash-receipt.controller.js';
import { VouchersModule } from '../vouchers/vouchers.module.js';

@Module({
  imports: [MongooseModule.forFeature([{ name: CashReceipt.name, schema: CashReceiptSchema }]), VouchersModule],
  controllers: [CashReceiptController],
  providers: [CashReceiptService, CashReceiptPrintService],
  exports: [CashReceiptService],
})
export class CashReceiptModule {}
