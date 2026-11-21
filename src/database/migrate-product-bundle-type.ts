/**
 * One-time migration: `pnpm migrate:product-bundle-type` (dry run) or `... --apply`.
 *
 * Products of type bundle become stock; recipes are untouched. Safe to re-run.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from '../app.module.js';
import { Product } from '../modules/product/products/schemas/product.schema.js';
import { backfillProductBundleType } from './backfill-product-bundle-type.js';

async function migrate(): Promise<void> {
  const logger = new Logger('MigrateProductBundleType');
  const apply = process.argv.includes('--apply');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const count = await backfillProductBundleType(app.get<Model<any>>(getModelToken(Product.name)).collection, apply);
    logger.log(apply ? `Products changed from bundle to stock: ${count}.` : `Dry run: ${count} product(s) would change. Re-run with --apply.`);
  } finally {
    await app.close();
  }
}

try {
  await migrate();
} catch (error) {
  console.error(`
[migrate:product-bundle-type] FAILED: ${error instanceof Error ? error.message : String(error)}
`);
  process.exitCode = 1;
}
