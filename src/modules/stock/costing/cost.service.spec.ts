import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Types, type ClientSession, type Connection, type Model } from 'mongoose';
import { mongooseTestRoot } from '../../../../test/mongo-test-db.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';
import { CostService, type CostRef } from './cost.service.js';
import { CostLayer, CostLayerSchema } from './schemas/cost-layer.schema.js';
import { LayerConsumption, LayerConsumptionSchema } from './schemas/layer-consumption.schema.js';
import { StockBalance, StockBalanceSchema } from '../schemas/stock-balance.schema.js';
import { Product, ProductSchema } from '../../product/products/schemas/product.schema.js';
import { InTransitRegistry } from '../pending-receipt.js';

describe('FIFO costing', () => {
  let moduleRef: TestingModule;
  let cost: CostService;
  const model = <T>(name: string) => moduleRef.get<Model<T>>(getModelToken(name));
  const tx = <T>(work: (session: ClientSession) => Promise<T>) =>
    runInTransaction(moduleRef.get<Connection>(getConnectionToken()), work);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('costing'),
        MongooseModule.forFeature([
          { name: CostLayer.name, schema: CostLayerSchema },
          { name: LayerConsumption.name, schema: LayerConsumptionSchema },
          { name: StockBalance.name, schema: StockBalanceSchema },
          { name: Product.name, schema: ProductSchema },
        ]),
      ],
      providers: [CostService, InTransitRegistry],
    }).compile();
    cost = moduleRef.get(CostService);
    await Promise.all([CostLayer, LayerConsumption, StockBalance].map((m) => model(m.name).init()));
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  afterEach(async () => {
    await Promise.all([CostLayer, LayerConsumption, StockBalance].map((m) => model(m.name).collection.deleteMany({})));
  });

  const product = new Types.ObjectId();
  let day = 0;
  const buy = (qty: number, unitCost: number, sourceVoucherId = new Types.ObjectId()) =>
    tx((session) =>
      cost.addLayer(
        { productId: product, sourceType: 'purchase-invoice', sourceVoucherId, date: new Date(2026, 0, ++day), qty, unitCost },
        session,
      ),
    ).then(() => sourceVoucherId);
  const ref = (voucherNo: string, voucherId = new Types.ObjectId()): CostRef => ({
    voucherType: 'sales-invoice',
    voucherId,
    voucherNo,
    lineId: new Types.ObjectId(),
  });
  const sell = (qty: number, r: CostRef) => tx((session) => cost.consume(product, qty, r, session));
  const remaining = async () =>
    (await model<{ qtyRemaining: number }>(CostLayer.name).find().sort({ date: 1 }).lean().exec()).map((l) => l.qtyRemaining);

  it('sells across layers oldest first: 100 at 10 then 100 at 12, sell 120 costs 1,240', async () => {
    await buy(100, 10);
    await buy(100, 12);
    const result = await sell(120, ref('SI-0001'));

    expect(result).toMatchObject({ totalCost: 1240, avgUnitCost: 10.3333, uncosted: false });
    expect(result.consumptions.map((c) => [c.qty, c.unitCost])).toEqual([
      [100, 10],
      [20, 12],
    ]);
    expect(await remaining()).toEqual([0, 80]);
  });

  it('buy 100 at 25, sell 60, buy 100 at 35, sell 80: 1,500 then 2,400, closing value 2,100', async () => {
    await buy(100, 25);
    expect((await sell(60, ref('SI-0001'))).totalCost).toBe(1500);
    await buy(100, 35);
    expect((await sell(80, ref('SI-0002'))).totalCost).toBe(2400);

    const valuation = await cost.valuation([product]);
    expect(valuation.get(product.toString())).toMatchObject({ qty: 60, value: 2100 });
  });

  it('restore puts the quantities back into the exact layers; a partial restore splits the row', async () => {
    await buy(100, 10);
    await buy(100, 12);
    const first = ref('SI-0001');
    await sell(120, first);

    await tx((session) => cost.restore(first, 10, session));
    expect(await remaining()).toEqual([10, 80]); // consumption order: the oldest layer first
    await tx((session) => cost.reverseAll(first, session));
    expect(await remaining()).toEqual([100, 100]);
    expect(await model(LayerConsumption.name).countDocuments({ reversedAt: null })).toBe(0);
  });

  it('a shortage is costed at the latest layer cost, flagged uncosted, and never backfilled', async () => {
    await buy(10, 8);
    const result = await sell(15, ref('SI-0001'));
    expect(result).toMatchObject({ totalCost: 120, uncosted: true });
    expect(result.consumptions[1]).toMatchObject({ layerId: null, qty: 5, unitCost: 8, uncosted: true });

    await buy(20, 9);
    expect(await remaining()).toEqual([0, 20]);
  });

  it('a strict consume prefers one source layer, then the oldest, and refuses when too little remains', async () => {
    await buy(100, 10);
    const second = await buy(100, 12);
    const own = { sourceType: 'purchase-invoice', sourceVoucherId: second };
    const taken = await tx((session) => cost.consume(product, 30, ref('PR-0001'), session, { preferSource: own, strict: true }));
    expect(taken).toMatchObject({ totalCost: 360, uncosted: false });
    expect(await remaining()).toEqual([100, 70]);

    await expect(tx((session) => cost.consume(product, 171, ref('PR-0002'), session, { strict: true }))).rejects.toThrow(/Not enough stock left/);
    expect(await remaining()).toEqual([100, 70]);
  });

  it('retiring a purchase layer is refused while any of it is used, naming the vouchers', async () => {
    const purchase = await buy(100, 10);
    const sale = ref('SI-0042');
    await sell(30, sale);
    await expect(
      tx((session) => cost.removeLayers('purchase-invoice', purchase, 'Purchase invoice PI-0001', 'cancelled', session)),
    ).rejects.toThrow("Purchase invoice PI-0001 can't be cancelled: its stock was already used on SI-0042");

    await tx((session) => cost.reverseAll(sale, session));
    await tx((session) => cost.removeLayers('purchase-invoice', purchase, 'Purchase invoice PI-0001', 'cancelled', session));
    expect(await remaining()).toEqual([0]);
  });

  it('invariant: layer quantity equals stock on hand plus in transit, per product', async () => {
    const transitProduct = new Types.ObjectId();
    const transit = moduleRef.get(InTransitRegistry);
    transit.register('test', async () => new Map([[transitProduct.toString(), 4]]));

    await buy(100, 10);
    await sell(30, ref('SI-0001'));
    await model(StockBalance.name).create([
      { productId: product, locationId: new Types.ObjectId(), qty: 50 },
      { productId: product, locationId: new Types.ObjectId(), qty: 20 },
      { productId: transitProduct, locationId: new Types.ObjectId(), qty: 6 },
    ]);
    await tx((session) =>
      cost.addLayer(
        { productId: transitProduct, sourceType: 'opening-stock', sourceVoucherId: new Types.ObjectId(), date: new Date(), qty: 10, unitCost: 3 },
        session,
      ),
    );

    expect(await cost.reconcile()).toEqual([]);
    await model(StockBalance.name).updateOne({ productId: product, qty: 20 }, { $inc: { qty: 1 } });
    expect(await cost.reconcile()).toEqual([
      { productId: product.toString(), layerQty: 70, onHand: 71, inTransit: 0, diff: -1 },
    ]);
  });
});
