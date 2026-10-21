import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CashHandover, CashHandoverSchema } from './schemas/cash-handover.schema.js';
import { CashHandoverService } from './cash-handover.service.js';
import { CashHandoverController } from './cash-handover.controller.js';
import { VouchersModule } from '../vouchers/vouchers.module.js';
import { LedgerAccountModule } from '../ledger-accounts/ledger-account.module.js';
import { UsersModule } from '../../users/users.module.js';
import { CompanyModule } from '../../company/company.module.js';
import { CommentsModule } from '../../comments/comments.module.js';
import { SequenceModule } from '../../sequence/sequence.module.js';
import { AuditModule } from '../../audit/audit.module.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: CashHandover.name, schema: CashHandoverSchema }]),
    VouchersModule,
    LedgerAccountModule,
    UsersModule,
    CompanyModule,
    CommentsModule,
    SequenceModule,
    AuditModule,
  ],
  controllers: [CashHandoverController],
  providers: [CashHandoverService],
  exports: [CashHandoverService],
})
export class CashHandoverModule {}
