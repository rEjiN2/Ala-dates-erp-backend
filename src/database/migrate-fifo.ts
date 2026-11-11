/**
 * One-time migration: `pnpm migrate:fifo` (dry run) or `pnpm migrate:fifo --apply`.
 *
 * Builds FIFO cost layers from existing stock entries and backfills sales
 * costs. Run it before the first costed sale. Safe to re-run. See
 * backfill-fifo.ts.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { AppModule } from '../app.module.js';
import { StockEntry } from '../modules/stock/schemas/stock-entry.schema.js';
import { StockBalance } from '../modules/stock/schemas/stock-balance.schema.js';
import { StockTransfer } from '../modules/stock/transfers/schemas/stock-transfer.schema.js';
import { CostLayer } from '../modules/stock/costing/schemas/cost-layer.schema.js';
import { LayerConsumption } from '../modules/stock/costing/schemas/layer-consumption.schema.js';
import { Product } from '../modules/product/products/schemas/product.schema.js';
import { SalesInvoice } from '../modules/sales/sales-invoices/schemas/sales-invoice.schema.js';
import { runInTransaction } from '../common/utils/transaction.util.js';
import { backfillFifo } from './backfill-fifo.js';

async function migrate(): Promise<void> {
  const logger = new Logger('MigrateFifo');
  const apply = process.argv.includes('--apply');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const collection = (name: string) => app.get<Model<any>>(getModelToken(name)).collection;
    const connection = app.get<Connection>(getConnectionToken());
    const report = await backfillFifo(
      {
        entries: collection(StockEntry.name),
        products: collection(Product.name),
        balances: collection(StockBalance.name),
        transfers: collection(StockTransfer.name),
        layers: collection(CostLayer.name),
        consumptions: collection(LayerConsumption.name),
        salesInvoices: collection(SalesInvoice.name),
      },
      { apply },
      (work) => runInTransaction(connection, work),
    );
    logger.log(
      `${apply ? 'APPLIED' : 'DRY RUN (nothing written; add --apply)'}: ${report.products} products, ${report.layers} layers, ` +
        `${report.consumptions} consumptions, ${report.invoicesCosted} sales invoices costed, ${report.skipped} products skipped (already have layers).`,
    );
    if (report.mismatches.length === 0) {
      logger.log('Reconciliation: every product matches on hand + in transit.');
    } else {
      logger.warn(`Reconciliation: ${report.mismatches.length} product(s) differ (layers - (on hand + in transit)):`);
      for (const row of report.mismatches) {
        logger.warn(`  ${row.code}: layers ${row.layerQty}, on hand ${row.onHand}, in transit ${row.inTransit}, diff ${row.diff}`);
      }
    }
  } finally {
    await app.close();
  }
}

try {
  await migrate();
} catch (error) {
  console.error(`\n[migrate:fifo] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
