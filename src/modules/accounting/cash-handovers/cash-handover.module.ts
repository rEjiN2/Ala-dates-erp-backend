import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CashHandover, CashHandoverSchema } from './schemas/cash-handover.schema.js';
import { CashHandoverService } from './cash-handover.service.js';
import { CashHandoverController } from './cash-handover.controller.js';
import { VouchersModule } from '../vouchers/vouchers.module.js';
import { LedgerAccountModule } from '../ledger-accounts/ledger-account.module.js';
import { CashierModule } from '../../cashier/cashier.module.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: CashHandover.name, schema: CashHandoverSchema }]),
    VouchersModule,
    LedgerAccountModule,
    CashierModule,
  ],
  controllers: [CashHandoverController],
  providers: [CashHandoverService],
  exports: [CashHandoverService],
})
export class CashHandoverModule {}
