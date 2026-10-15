import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LedgerAccount, LedgerAccountSchema } from './schemas/ledger-account.schema.js';
import { LedgerAccountService } from './ledger-account.service.js';
import { LedgerAccountController } from './ledger-account.controller.js';
import { LedgerAccountUsageRegistry } from './ledger-account-usage.registry.js';
import { LocationModule } from '../../location/location.module.js';
import { SequenceModule } from '../../sequence/sequence.module.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: LedgerAccount.name, schema: LedgerAccountSchema }]),
    LocationModule,
    SequenceModule,
  ],
  controllers: [LedgerAccountController],
  providers: [LedgerAccountService, LedgerAccountUsageRegistry],
  exports: [LedgerAccountService, LedgerAccountUsageRegistry],
})
export class LedgerAccountModule {}
