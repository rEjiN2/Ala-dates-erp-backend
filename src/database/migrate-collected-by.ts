/**
 * One-time migration: `pnpm migrate:collected-by`.
 *
 * Run once after deploying Collected By / Paid By as users (Cashier master
 * removed), then `pnpm seed` (drops cashiers:manage, adds
 * vouchers:select-collector). Safe to re-run. See backfill-collected-by.ts.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { AppModule } from '../app.module.js';
import { User, UserDocument } from '../modules/users/schemas/user.schema.js';
import { backfillCollectedBy } from './backfill-collected-by.js';

async function migrate(): Promise<void> {
  const logger = new Logger('MigrateCollectedBy');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const connection = app.get<Connection>(getConnectionToken());
    const result = await backfillCollectedBy({
      cashiers: connection.collection('cashiers'),
      user: app.get<Model<UserDocument>>(getModelToken(User.name)),
      vouchers: ['cash_receipts', 'cash_payments', 'cash_handovers'].map((name) => connection.collection(name)),
    });
    logger.log(
      `Vouchers moved to a user: ${result.linkedVouchers}, kept by name only: ${result.unlinkedVouchers}; users updated: ${result.users}.`,
    );
  } finally {
    await app.close();
  }
}

try {
  await migrate();
} catch (error) {
  console.error(`\n[migrate:collected-by] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
