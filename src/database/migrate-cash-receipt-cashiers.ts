/**
 * One-time migration: `pnpm migrate:cash-receipt-cashiers`.
 *
 * Run once after deploying the cashier master, so receipts entered with a
 * free-text cashier show that name. Safe to re-run. See
 * backfill-cash-receipt-cashiers.ts.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from '../app.module.js';
import { CashReceipt, CashReceiptDocument } from '../modules/accounting/cash-receipts/schemas/cash-receipt.schema.js';
import { backfillCashReceiptCashiers } from './backfill-cash-receipt-cashiers.js';

async function migrate(): Promise<void> {
  const logger = new Logger('MigrateCashReceiptCashiers');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const result = await backfillCashReceiptCashiers(
      app.get<Model<CashReceiptDocument>>(getModelToken(CashReceipt.name)),
    );
    logger.log(`Moved the free-text cashier into cashierName on ${result.migrated} receipt(s).`);
  } finally {
    await app.close();
  }
}

try {
  await migrate();
} catch (error) {
  console.error(
    `\n[migrate:cash-receipt-cashiers] FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
