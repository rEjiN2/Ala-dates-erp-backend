/**
 * One-time migration: `pnpm migrate:staff-types`.
 *
 * Run once after deploying staffType / settlesWithOffice on the Cashier
 * master. Safe to re-run. See backfill-staff-types.ts.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from '../app.module.js';
import { Cashier, CashierDocument } from '../modules/cashier/schemas/cashier.schema.js';
import { backfillStaffTypes } from './backfill-staff-types.js';

async function migrate(): Promise<void> {
  const logger = new Logger('MigrateStaffTypes');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const result = await backfillStaffTypes(app.get<Model<CashierDocument>>(getModelToken(Cashier.name)));
    logger.log(
      `Set staffType "cashier" on ${result.staffType} and settlesWithOffice false on ${result.settles} record(s).`,
    );
  } finally {
    await app.close();
  }
}

try {
  await migrate();
} catch (error) {
  console.error(`\n[migrate:staff-types] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
