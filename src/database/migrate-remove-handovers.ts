/**
 * One-time migration: `pnpm migrate:remove-handovers`.
 *
 * Run once after deploying the removal of cash handovers, then `pnpm seed`
 * (drops the cash-handovers:* permissions from every role). Safe to re-run.
 * See backfill-remove-handovers.ts.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from '../app.module.js';
import { CashReceipt, CashReceiptDocument } from '../modules/accounting/cash-receipts/schemas/cash-receipt.schema.js';
import { backfillRemoveHandovers } from './backfill-remove-handovers.js';

async function migrate(): Promise<void> {
  const logger = new Logger('MigrateRemoveHandovers');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const result = await backfillRemoveHandovers(app.get<Model<CashReceiptDocument>>(getModelToken(CashReceipt.name)));
    logger.log(`Receipts unlocked (settlement fields removed): ${result.unlocked}.`);
  } finally {
    await app.close();
  }
}

try {
  await migrate();
} catch (error) {
  console.error(`\n[migrate:remove-handovers] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
