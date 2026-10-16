import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Party, PartySchema } from './schemas/party.schema.js';
import { PartyService } from './party.service.js';
import { PartyController } from './party.controller.js';
import { LedgerAccountModule } from '../accounting/ledger-accounts/ledger-account.module.js';
import { SequenceModule } from '../sequence/sequence.module.js';
import { FilesModule } from '../files/files.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { CommentsModule } from '../comments/comments.module.js';

/** Customers and suppliers, each with its own ledger account. */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Party.name, schema: PartySchema }]),
    LedgerAccountModule,
    SequenceModule,
    FilesModule,
    AuditModule,
    CommentsModule,
  ],
  controllers: [PartyController],
  providers: [PartyService],
  exports: [PartyService],
})
export class PartyModule {}
