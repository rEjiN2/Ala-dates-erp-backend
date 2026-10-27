/**
 * One-time migration: `pnpm migrate:invoice-line-ids`.
 *
 * Run once after deploying sales/purchase returns. Safe to re-run. See
 * backfill-invoice-line-ids.ts.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from '../app.module.js';
import { SalesInvoice } from '../modules/sales/sales-invoices/schemas/sales-invoice.schema.js';
import { PurchaseInvoice } from '../modules/purchase/purchase-invoices/schemas/purchase-invoice.schema.js';
import { backfillInvoiceLineIds } from './backfill-invoice-line-ids.js';

async function migrate(): Promise<void> {
  const logger = new Logger('MigrateInvoiceLineIds');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const stamped = await backfillInvoiceLineIds(
      [SalesInvoice.name, PurchaseInvoice.name].map((name) => app.get<Model<any>>(getModelToken(name)).collection),
    );
    logger.log(`Invoice lines given an _id: ${stamped}.`);
  } finally {
    await app.close();
  }
}

try {
  await migrate();
} catch (error) {
  console.error(`\n[migrate:invoice-line-ids] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
