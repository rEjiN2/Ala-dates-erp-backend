/**
 * One-time migration: `pnpm migrate:handover-approval`.
 *
 * Run once after deploying handover approval, after migrate:staff-types
 * (it reads settlesWithOffice). Safe to re-run. See backfill-handover-approval.ts.
 * Run `pnpm seed` too: it swaps cash-handovers:edit for the new permissions.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from '../app.module.js';
import { Cashier, CashierDocument } from '../modules/cashier/schemas/cashier.schema.js';
import { CashReceipt, CashReceiptDocument } from '../modules/accounting/cash-receipts/schemas/cash-receipt.schema.js';
import { CashHandover, CashHandoverDocument } from '../modules/accounting/cash-handovers/schemas/cash-handover.schema.js';
import { backfillHandoverApproval } from './backfill-handover-approval.js';

async function migrate(): Promise<void> {
  const logger = new Logger('MigrateHandoverApproval');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const result = await backfillHandoverApproval({
      cashier: app.get<Model<CashierDocument>>(getModelToken(Cashier.name)),
      receipt: app.get<Model<CashReceiptDocument>>(getModelToken(CashReceipt.name)),
      handover: app.get<Model<CashHandoverDocument>>(getModelToken(CashHandover.name)),
    });
    logger.log(
      `Receipts settled: ${result.settledReceipts}, not settling: ${result.otherReceipts}; handovers approved: ${result.approvedHandovers}.`,
    );
  } finally {
    await app.close();
  }
}

try {
  await migrate();
} catch (error) {
  console.error(`\n[migrate:handover-approval] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
