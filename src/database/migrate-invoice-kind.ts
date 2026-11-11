/**
 * One-time migration: `pnpm migrate:invoice-kind`.
 *
 * Run once after deploying non-VAT invoices. Safe to re-run. See backfill-invoice-kind.ts.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from '../app.module.js';
import { SalesInvoice } from '../modules/sales/sales-invoices/schemas/sales-invoice.schema.js';
import { SalesReturn } from '../modules/accounting/returns/schemas/return.schema.js';
import { backfillInvoiceKind } from './backfill-invoice-kind.js';

async function migrate(): Promise<void> {
  const logger = new Logger('MigrateInvoiceKind');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const updated = await backfillInvoiceKind(
      [SalesInvoice.name, SalesReturn.name].map((name) => app.get<Model<any>>(getModelToken(name)).collection),
    );
    logger.log(`Documents set to invoiceKind tax: ${updated}.`);
  } finally {
    await app.close();
  }
}

try {
  await migrate();
} catch (error) {
  console.error(`\n[migrate:invoice-kind] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
