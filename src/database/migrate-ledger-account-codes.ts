/**
 * One-time migration: `pnpm migrate:ledger-account-codes`.
 *
 * Run once after deploying generated account codes, before anyone creates an
 * account. Safe to re-run. See backfill-ledger-account-codes.ts.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { AppModule } from '../app.module.js';
import {
  LedgerAccount,
  LedgerAccountDocument,
} from '../modules/accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { SequenceService } from '../modules/sequence/sequence.service.js';
import { backfillLedgerAccountCodes } from './backfill-ledger-account-codes.js';

async function migrate(): Promise<void> {
  const logger = new Logger('MigrateLedgerAccountCodes');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const result = await backfillLedgerAccountCodes({
      connection: app.get<Connection>(getConnectionToken()),
      ledgerAccountModel: app.get<Model<LedgerAccountDocument>>(getModelToken(LedgerAccount.name)),
      sequenceService: app.get(SequenceService),
    });

    logger.log(`Recoded ${result.recoded.length} account(s).`);
    for (const { from, to } of result.recoded) {
      logger.log(`  ${from} -> ${to} (old code kept as legacyCode)`);
    }
    for (const entry of result.duplicateNames) {
      logger.error(`Duplicate name within a type, blocks the unique name index; rename one by hand: ${entry}`);
    }
    if (result.duplicateNames.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

try {
  await migrate();
} catch (error) {
  console.error(`\n[migrate:ledger-account-codes] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
