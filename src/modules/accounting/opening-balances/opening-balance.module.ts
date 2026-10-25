import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OpeningBalance, OpeningBalanceSchema } from './schemas/opening-balance.schema.js';
import { OpeningBalanceService } from './opening-balance.service.js';
import { OpeningBalanceController } from './opening-balance.controller.js';
import { VouchersModule } from '../vouchers/vouchers.module.js';
import { LedgerAccountModule } from '../ledger-accounts/ledger-account.module.js';
import { SequenceModule } from '../../sequence/sequence.module.js';
import { AuditModule } from '../../audit/audit.module.js';
import { CommentsModule } from '../../comments/comments.module.js';
import { AllocationModule } from '../allocations/allocation.module.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: OpeningBalance.name, schema: OpeningBalanceSchema }]),
    VouchersModule,
    LedgerAccountModule,
    SequenceModule,
    AuditModule,
    CommentsModule,
    AllocationModule,
  ],
  controllers: [OpeningBalanceController],
  providers: [OpeningBalanceService],
  exports: [OpeningBalanceService],
})
export class OpeningBalanceModule {}
