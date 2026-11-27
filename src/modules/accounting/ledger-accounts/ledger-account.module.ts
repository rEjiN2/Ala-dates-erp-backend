import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LedgerAccount, LedgerAccountSchema } from './schemas/ledger-account.schema.js';
import { LedgerAccountService } from './ledger-account.service.js';
import { LedgerAccountController } from './ledger-account.controller.js';
import { LedgerAccountUsageRegistry } from './ledger-account-usage.registry.js';
import { User, UserSchema } from '../../users/schemas/user.schema.js';
import { AuditModule } from '../../audit/audit.module.js';
import { CommentsModule } from '../../comments/comments.module.js';
import { LocationModule } from '../../location/location.module.js';
import { SequenceModule } from '../../sequence/sequence.module.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LedgerAccount.name, schema: LedgerAccountSchema },
      { name: User.name, schema: UserSchema },
    ]),
    LocationModule,
    SequenceModule,
    AuditModule,
    CommentsModule,
  ],
  controllers: [LedgerAccountController],
  providers: [LedgerAccountService, LedgerAccountUsageRegistry],
  exports: [LedgerAccountService, LedgerAccountUsageRegistry],
})
export class LedgerAccountModule {}
