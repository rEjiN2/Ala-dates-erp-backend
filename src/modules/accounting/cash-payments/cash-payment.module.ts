import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CashPayment, CashPaymentSchema } from './schemas/cash-payment.schema.js';
import { CashPaymentService } from './cash-payment.service.js';
import { CashPaymentController } from './cash-payment.controller.js';
import { VouchersModule } from '../vouchers/vouchers.module.js';
import { AllocationModule } from '../allocations/allocation.module.js';

@Module({
  imports: [MongooseModule.forFeature([{ name: CashPayment.name, schema: CashPaymentSchema }]), VouchersModule, AllocationModule],
  controllers: [CashPaymentController],
  providers: [CashPaymentService],
  exports: [CashPaymentService],
})
export class CashPaymentModule {}
