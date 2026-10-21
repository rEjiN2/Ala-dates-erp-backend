import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LedgerEntry, LedgerEntrySchema } from './schemas/ledger-entry.schema.js';
import { VoucherPostingService } from './voucher-posting.service.js';
import { VoucherPrintService } from './voucher-print.service.js';
import { LedgerAccountModule } from '../ledger-accounts/ledger-account.module.js';
import { SequenceModule } from '../../sequence/sequence.module.js';
import { AuditModule } from '../../audit/audit.module.js';
import { CommentsModule } from '../../comments/comments.module.js';
import { UsersModule } from '../../users/users.module.js';
import { CompanyModule } from '../../company/company.module.js';

/** The posting engine and PDF printing shared by every cash/bank voucher module. */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: LedgerEntry.name, schema: LedgerEntrySchema }]),
    LedgerAccountModule,
    SequenceModule,
    AuditModule,
    CommentsModule,
    UsersModule,
    CompanyModule,
  ],
  providers: [VoucherPostingService, VoucherPrintService],
  exports: [VoucherPostingService, VoucherPrintService],
})
export class VouchersModule {}
