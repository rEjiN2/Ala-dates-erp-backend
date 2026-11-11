import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Types, type Connection, type Model } from 'mongoose';
import { mongooseTestRoot } from '../../test/mongo-test-db.js';
import { runInTransaction } from '../common/utils/transaction.util.js';
import { backfillFifo, type FifoCollections } from './backfill-fifo.js';
import { StockEntry, StockEntrySchema } from '../modules/stock/schemas/stock-entry.schema.js';
import { StockBalance, StockBalanceSchema } from '../modules/stock/schemas/stock-balance.schema.js';
import { StockTransfer, StockTransferSchema } from '../modules/stock/transfers/schemas/stock-transfer.schema.js';
import { CostLayer, CostLayerSchema } from '../modules/stock/costing/schemas/cost-layer.schema.js';
import { LayerConsumption, LayerConsumptionSchema } from '../modules/stock/costing/schemas/layer-consumption.schema.js';
import { Product, ProductSchema } from '../modules/product/products/schemas/product.schema.js';
import { SalesInvoice, SalesInvoiceSchema } from '../modules/sales/sales-invoices/schemas/sales-invoice.schema.js';

describe('backfillFifo (pnpm migrate:fifo)', () => {
  let moduleRef: TestingModule;
  const model = (name: string) => moduleRef.get<Model<any>>(getModelToken(name));
  const db = (): FifoCollections => ({
    entries: model(StockEntry.name).collection,
    products: model(Product.name).collection,
    balances: model(StockBalance.name).collection,
    transfers: model(StockTransfer.name).collection,
    layers: model(CostLayer.name).collection,
    consumptions: model(LayerConsumption.name).collection,
    salesInvoices: model(SalesInvoice.name).collection,
  });
  const run = (apply: boolean) =>
    backfillFifo(db(), { apply }, (work) => runInTransaction(moduleRef.get<Connection>(getConnectionToken()), work));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('backfill_fifo'),
        MongooseModule.forFeature([
          { name: StockEntry.name, schema: StockEntrySchema },
          { name: StockBalance.name, schema: StockBalanceSchema },
          { name: StockTransfer.name, schema: StockTransferSchema },
          { name: CostLayer.name, schema: CostLayerSchema },
          { name: LayerConsumption.name, schema: LayerConsumptionSchema },
          { name: Product.name, schema: ProductSchema },
          { name: SalesInvoice.name, schema: SalesInvoiceSchema },
        ]),
      ],
    }).compile();
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  afterEach(async () => {
    await Promise.all(
      [StockEntry, StockBalance, StockTransfer, CostLayer, LayerConsumption, Product, SalesInvoice].map((m) =>
        model(m.name).collection.deleteMany({}),
      ),
    );
  });

  const productId = new Types.ObjectId();
  const wh = new Types.ObjectId();
  const van = new Types.ObjectId();
  let tick = 0;
  /** Raw stock entry (the engine's insert-only rows), dated in order. */
  const entry = (qty: number, extra: Record<string, unknown> = {}) => {
    const _id = new Types.ObjectId();
    const date = new Date(2026, 0, 1 + ++tick);
    return model(StockEntry.name).collection.insertOne({
      _id,
      productId,
      locationId: wh,
      qty,
      date,
      voucherType: 'purchase-invoice',
      voucherId: new Types.ObjectId(),
      voucherNo: `V-${tick}`,
      unitCost: null,
      reversalOf: null,
      postedAt: date,
      ...extra,
    });
  };

  it('dry run reconciles and writes nothing; apply builds layers once and costs the sales line', async () => {
    await model(Product.name).collection.insertOne({ _id: productId, code: 'PRD-0001', purchasePrice: 9 });
    const invoiceId = new Types.ObjectId();
    const lineId = new Types.ObjectId();
    await model(SalesInvoice.name).collection.insertOne({
      _id: invoiceId,
      status: 'posted',
      taxableTotal: 2000,
      lines: [{ _id: lineId, productId, qty: 120 }],
    });
    await entry(100, { unitCost: 10 });
    await entry(100, { unitCost: 12 });
    await entry(-120, { voucherType: 'sales-invoice', voucherId: invoiceId, voucherNo: 'SI-0001' });
    // A cancelled purchase (entry + its reversal) and a transfer van <- wh never touch layers.
    const cancelled = new Types.ObjectId();
    await entry(50, { unitCost: 99, _id: cancelled });
    await entry(-50, { reversalOf: cancelled });
    await entry(-10, { voucherType: 'stock-transfer', locationId: wh });
    await entry(6, { voucherType: 'stock-transfer', locationId: van });
    await model(StockBalance.name).collection.insertMany([
      { productId, locationId: wh, qty: 70 },
      { productId, locationId: van, qty: 6 },
    ]);
    // 4 still in transit: on hand 76 + 4 = 80 = 200 bought - 120 sold.
    await model(StockTransfer.name).collection.insertOne({ status: 'in_transit', lines: [{ productId, qty: 4 }] });

    const dry = await run(false);
    expect(dry).toMatchObject({ apply: false, products: 1, layers: 2, invoicesCosted: 1, mismatches: [] });
    expect(await model(CostLayer.name).countDocuments()).toBe(0);

    const applied = await run(true);
    expect(applied).toMatchObject({ apply: true, products: 1, layers: 2, mismatches: [] });
    const layers = await model(CostLayer.name).find().sort({ date: 1 }).lean();
    expect(layers.map((l) => [l.qtyIn, l.qtyRemaining, l.unitCost])).toEqual([
      [100, 0, 10],
      [100, 80, 12],
    ]);
    const invoice = await model(SalesInvoice.name).collection.findOne({ _id: invoiceId });
    expect(invoice).toMatchObject({ costTotal: 1240, margin: 760 });
    expect(invoice!.lines[0]).toMatchObject({ costAmount: 1240, uncosted: false });
    expect(await model(LayerConsumption.name).find({ voucherId: invoiceId }).lean()).toMatchObject([
      { lineId, qty: 100, unitCost: 10 },
      { lineId, qty: 20, unitCost: 12 },
    ]);

    // Idempotent: layers exist, so the product is skipped.
    expect(await run(true)).toMatchObject({ products: 0, skipped: 1, layers: 0 });
    expect(await model(CostLayer.name).countDocuments()).toBe(2);
  });

  it('lists products whose layers do not match on hand plus in transit', async () => {
    await model(Product.name).collection.insertOne({ _id: productId, code: 'PRD-0001', purchasePrice: 9 });
    await entry(10);
    await model(StockBalance.name).collection.insertOne({ productId, locationId: wh, qty: 8 });

    const report = await run(false);
    expect(report.mismatches).toEqual([{ productId: productId.toString(), code: 'PRD-0001', layerQty: 10, onHand: 8, inTransit: 0, diff: 2 }]);
  });
});
