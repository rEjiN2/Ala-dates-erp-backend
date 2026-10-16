/**
 * One-time migration: `pnpm migrate:code-sequences`.
 *
 * Run once after deploying generated Location / Product Group codes (and again
 * after deploying Parties and Cashiers), before
 * anyone creates a record, so the counters start above every code that was
 * entered by hand. Safe to re-run; it never renames a record or lowers a
 * counter. See sync-code-sequences.ts for the rules.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from '../app.module.js';
import { Location, LocationDocument } from '../modules/location/schemas/location.schema.js';
import { ProductGroup, ProductGroupDocument } from '../modules/product/product-groups/schemas/product-group.schema.js';
import { SequenceService } from '../modules/sequence/sequence.service.js';
import { Party } from '../modules/party/schemas/party.schema.js';
import { Cashier } from '../modules/cashier/schemas/cashier.schema.js';
import { LedgerAccount } from '../modules/accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { syncCodeSequences } from './sync-code-sequences.js';

async function migrate(): Promise<void> {
  const logger = new Logger('MigrateCodeSequences');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const results = await syncCodeSequences({
      locationModel: app.get<Model<LocationDocument>>(getModelToken(Location.name)),
      productGroupModel: app.get<Model<ProductGroupDocument>>(getModelToken(ProductGroup.name)),
      sequenceService: app.get(SequenceService),
      partyModel: app.get<Model<unknown>>(getModelToken(Party.name)),
      ledgerAccountModel: app.get<Model<unknown>>(getModelToken(LedgerAccount.name)),
      cashierModel: app.get<Model<unknown>>(getModelToken(Cashier.name)),
    });

    for (const result of results) {
      logger.log(
        `${result.key}: highest existing ${result.prefix}${result.highestExisting}, counter now ${result.counter} (next code uses ${result.counter + 1})`,
      );
    }
  } finally {
    await app.close();
  }
}

try {
  await migrate();
} catch (error) {
  console.error(`\n[migrate:code-sequences] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
