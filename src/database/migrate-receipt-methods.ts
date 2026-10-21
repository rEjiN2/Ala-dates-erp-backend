/**
 * One-time migration: `pnpm migrate:receipt-methods`.
 *
 * Run once after deploying cheque receipts, then `pnpm seed` (cheques:*
 * permissions, the Cheques in Hand account). Safe to re-run. See
 * backfill-receipt-methods.ts.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from '../app.module.js';
import { CashReceipt, CashReceiptDocument } from '../modules/accounting/cash-receipts/schemas/cash-receipt.schema.js';
import {
  LedgerAccount,
  LedgerAccountDocument,
} from '../modules/accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { backfillReceiptMethods } from './backfill-receipt-methods.js';

async function migrate(): Promise<void> {
  const logger = new Logger('MigrateReceiptMethods');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const result = await backfillReceiptMethods({
      receipt: app.get<Model<CashReceiptDocument>>(getModelToken(CashReceipt.name)),
      account: app.get<Model<LedgerAccountDocument>>(getModelToken(LedgerAccount.name)),
    });
    logger.log(`Payment method set: bank ${result.bank}, cheque ${result.cheque}, cash ${result.cash}.`);
  } finally {
    await app.close();
  }
}

try {
  await migrate();
} catch (error) {
  console.error(`\n[migrate:receipt-methods] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
