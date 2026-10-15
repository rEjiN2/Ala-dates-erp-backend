/**
 * One-time migration: `pnpm migrate:location-ancestors`.
 *
 * Run once after deploying the ancestors/depth fields, before anyone moves or
 * deactivates a location: descendant lookups, depth limits and move updates
 * all read that cache. Safe to re-run. See backfill-location-ancestors.ts.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from '../app.module.js';
import { Location, LocationDocument } from '../modules/location/schemas/location.schema.js';
import { backfillLocationAncestors } from './backfill-location-ancestors.js';

async function migrate(): Promise<void> {
  const logger = new Logger('MigrateLocationAncestors');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const result = await backfillLocationAncestors(app.get<Model<LocationDocument>>(getModelToken(Location.name)));

    logger.log(`Scanned ${result.scanned} location(s), updated ${result.updated}.`);
    for (const entry of result.tooDeep) {
      logger.warn(`Deeper than allowed (written, but fix by moving it up): ${entry}`);
    }
    for (const entry of result.skipped) {
      logger.error(`Skipped, broken parent chain (fix parentId by hand, then re-run): ${entry}`);
    }
    if (result.skipped.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

try {
  await migrate();
} catch (error) {
  console.error(`\n[migrate:location-ancestors] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
