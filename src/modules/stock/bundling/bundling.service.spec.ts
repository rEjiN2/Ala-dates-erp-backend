import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Types, type Connection, type Model } from 'mongoose';
import request from 'supertest';
import { mongooseTestRoot } from '../../../../test/mongo-test-db.js';
import { CostService } from '../costing/cost.service.js';
import { CostLayer, CostLayerSchema } from '../costing/schemas/cost-layer.schema.js';
import { LayerConsumption, LayerConsumptionSchema } from '../costing/schemas/layer-consumption.schema.js';
import { StockService } from '../stock.service.js';
import { StockEntry, StockEntrySchema } from '../schemas/stock-entry.schema.js';
import { StockBalance, StockBalanceSchema } from '../schemas/stock-balance.schema.js';
import { BundlingService } from './bundling.service.js';
import { BundlingController } from './bundling.controller.js';
import { BundleMasterService } from './bundle-master.service.js';
import { BundleRecipe, BundleRecipeSchema } from './schemas/bundle-recipe.schema.js';
import { Bundling, BundlingMode, BundlingSchema } from './schemas/bundling.schema.js';
import { Product, ProductSchema, ProductType } from '../../product/products/schemas/product.schema.js';
import { ProductService } from '../../product/products/product.service.js';
import { ProductUsageRegistry } from '../../product/products/product-usage.registry.js';
import { ProductGroup, ProductGroupSchema } from '../../product/product-groups/schemas/product-group.schema.js';
import { Unit, UnitSchema } from '../../product/units/schemas/unit.schema.js';
import { Location, LocationSchema, LocationType } from '../../location/schemas/location.schema.js';
import { CompanyService } from '../../company/company.service.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { Counter, CounterSchema } from '../../sequence/schemas/counter.schema.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditLog, AuditLogSchema } from '../../audit/schemas/audit-log.schema.js';
import { CommentsService } from '../../comments/comments.service.js';
import { EntityAccessRegistry } from '../../comments/entity-access.registry.js';
import { Comment, CommentSchema } from '../../comments/schemas/comment.schema.js';
import { FilesService } from '../../files/files.service.js';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { createAppValidationPipe } from '../../../common/pipes/app-validation.pipe.js';
import { configureHttpApp } from '../../../common/http/configure-http-app.js';
import { ADMIN_PERMISSIONS, VAN_SALESMAN_PERMISSIONS } from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';

const user = (name: string, permissions: string[] = [...ADMIN_PERMISSIONS]) => ({
  id: new Types.ObjectId().toString(),
  email: `${name.toLowerCase()}@example.com`,
  name,
  role: { id: new Types.ObjectId().toString(), name: 'r' },
  permissions,
});

describe('Bundling', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let bundling: BundlingService;
  let stock: StockService;
  const admin = user('Admin');
  let tokenUser: AuthenticatedUser = admin;
  const model = <T>(name: string) => moduleRef.get<Model<T>>(getModelToken(name));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('bundling'),
        MongooseModule.forFeature([
          { name: StockEntry.name, schema: StockEntrySchema },
          { name: StockBalance.name, schema: StockBalanceSchema },
          { name: CostLayer.name, schema: CostLayerSchema },
          { name: LayerConsumption.name, schema: LayerConsumptionSchema },
          { name: Bundling.name, schema: BundlingSchema },
          { name: BundleRecipe.name, schema: BundleRecipeSchema },
          { name: Product.name, schema: ProductSchema },
          { name: ProductGroup.name, schema: ProductGroupSchema },
          { name: Unit.name, schema: UnitSchema },
          { name: Location.name, schema: LocationSchema },
          { name: Counter.name, schema: CounterSchema },
          { name: AuditLog.name, schema: AuditLogSchema },
          { name: Comment.name, schema: CommentSchema },
        ]),
      ],
      controllers: [BundlingController],
      providers: [
        StockService,
        CostService,
        BundlingService,
        BundleMasterService,
        ProductService,
        ProductUsageRegistry,
        SequenceService,
        AuditService,
        CommentsService,
        EntityAccessRegistry,
        { provide: CompanyService, useValue: { ensure: async () => ({ allowNegativeStock: false }) } },
        { provide: FilesService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = tokenUser;
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    configureHttpApp(app);
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    bundling = moduleRef.get(BundlingService);
    stock = moduleRef.get(StockService);
    await Promise.all([StockEntry, StockBalance, CostLayer, LayerConsumption, Bundling, BundleRecipe, Product, Location, Counter, AuditLog].map((m) => model(m.name).init()));
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  afterEach(async () => {
    tokenUser = admin;
    await Promise.all(
      [StockEntry, StockBalance, Bundling, BundleRecipe, Product, ProductGroup, Unit, Location, Counter, AuditLog, Comment].map((m) =>
        model(m.name).collection.deleteMany({}),
      ),
    );
  });

  type Ref = { _id: Types.ObjectId };
  async function fixtures() {
    const group = await model(ProductGroup.name).create({ code: 'PG-0001', name: 'Dates' });
    const unit = await model(Unit.name).create({ name: 'Piece', symbol: 'pc' });
    const prd = async (code: string, type: ProductType, purchasePrice: number) =>
      (await model<Product>(Product.name).create({
        code,
        name: `${code} name`,
        productGroupId: group._id as Types.ObjectId,
        unitId: unit._id as Types.ObjectId,
        type,
        purchasePrice,
      })) as unknown as Ref;
    const wh = (await model<Location>(Location.name).create({
      code: 'WH-0001',
      name: 'Main',
      type: LocationType.WAREHOUSE,
    })) as unknown as Ref;
    return {
      wh,
      dates: await prd('PRD-0001', ProductType.STOCK, 10),
      box: await prd('PRD-0002', ProductType.STOCK, 2),
      gift: await prd('PRD-0003', ProductType.BUNDLE, 0),
      service: await prd('PRD-0004', ProductType.NON_STOCK, 0),
    };
  }
  type Fx = Awaited<ReturnType<typeof fixtures>>;

  const move = (productId: Types.ObjectId, locationId: Types.ObjectId, qty: number) =>
    runInTransaction(moduleRef.get<Connection>(getConnectionToken()), (session) =>
      stock.post(
        [{ productId, locationId, qty, date: new Date('2026-02-01'), voucherType: 'test', costing: 'none', voucherId: new Types.ObjectId(), voucherNo: 'T-1' }],
        admin,
        session,
      ),
    );

  const qtyOf = async (productId: Types.ObjectId, locationId: Types.ObjectId) =>
    (await model<{ qty: number }>(StockBalance.name).findOne({ productId, locationId }).lean().exec())?.qty ?? 0;

  /** 2 dates + 1 box per gift pack, 1.50 packing: cost 2x10 + 1x2 + 1.5 = 23.5. */
  async function recipe(f: Fx) {
    await bundling.setRecipe(
      f.gift._id.toString(),
      { components: [{ productId: f.dates._id.toString(), qty: 2 }, { productId: f.box._id.toString(), qty: 1 }], extraCostPerUnit: 1.5 },
      admin,
    );
  }
  const make = (f: Fx, qty: number, mode = BundlingMode.BUNDLE) =>
    bundling.create(
      { date: '2026-02-02', locationId: f.wh._id.toString(), mode, bundleProductId: f.gift._id.toString(), qty },
      admin,
    );

  it('bundle master: hidden from products list, parts validated, compose extends the recipe without saving', async () => {
    const f = await fixtures();
    await model(Counter.name).collection.insertOne({ key: 'product', seq: 10 });
    const masters = moduleRef.get(BundleMasterService);
    const products = moduleRef.get(ProductService);
    const group = (await model(ProductGroup.name).findOne().lean().exec())!._id.toString();
    const unit = (await model(Unit.name).findOne().lean().exec())!._id.toString();
    const base = { name: 'Gift Master', productGroupId: group, unitId: unit, salePrice: 30 };
    const parts = [{ productId: f.dates._id.toString(), qtyPerBundle: 2 }, { productId: f.box._id.toString(), qtyPerBundle: 1 }];

    await expect(masters.create({ ...base, parts: [parts[0], parts[0]] }, admin)).rejects.toThrow(/more than one line/);
    await expect(masters.create({ ...base, parts: [{ productId: f.service._id.toString(), qtyPerBundle: 1 }] }, admin)).rejects.toThrow(/stock products/);
    expect(await model(Product.name).countDocuments({ name: 'Gift Master' })).toBe(0); // rolled back

    const created = await masters.create({ ...base, parts, defaultExtraCostPerUnit: 1.5 }, admin);
    expect(created.parts).toHaveLength(2);
    await expect(masters.create({ ...base, name: 'Other', parts: [{ productId: created.id, qtyPerBundle: 1 }] }, admin)).rejects.toThrow(/is a bundle/);
    const page = (query: object) => products.list({ page: 1, limit: 20, ...query });
    expect((await page({})).items.map((p) => p.id)).not.toContain(created.id);
    expect((await page({ isBundle: true })).items.map((p) => p.id)).toEqual([created.id]);
    expect((await products.lookup({ q: 'Gift Master', limit: 50 })).map((p) => p.id)).toEqual([created.id]);
    const look = async (isBundle?: boolean) => (await products.lookup({ limit: 50, isBundle })).map((p) => p.id);
    const plain = [f.dates._id.toString(), f.box._id.toString()];
    expect(await look(false)).not.toContain(created.id);
    expect(await look(false)).toEqual(expect.arrayContaining(plain));
    expect(await look(true)).toEqual([created.id]);
    expect(await look()).toEqual(expect.arrayContaining([created.id, ...plain]));
    await expect(masters.update(created.id, { ...base, parts }, admin)).rejects.toThrow(/No changes/);
    expect((await masters.update(created.id, { ...base, salePrice: 35, parts }, admin)).salePrice).toBe(35);
    expect((await masters.findAll({ page: 1, pageSize: 20, q: 'gift' })).total).toBe(1);

    // pack with a different box qty and one extra part; the saved recipe stays as it was
    const extra = (await model<Product>(Product.name).create({
      code: 'PRD-0009', name: 'Ribbon', productGroupId: new Types.ObjectId(group), unitId: new Types.ObjectId(unit), type: ProductType.STOCK,
    })) as unknown as Ref;
    for (const p of [f.dates, f.box, extra]) await move(p._id, f.wh._id, 50);
    const out = await bundling.compose(
      {
        mode: BundlingMode.BUNDLE, locationId: f.wh._id.toString(), date: '2026-02-02', qty: 1, product: { id: created.id },
        parts: [{ productId: f.box._id.toString(), qtyPerBundle: 2 }, { productId: extra._id.toString(), qtyPerBundle: 1 }],
      },
      admin,
    );
    expect(out.bundling!.recipeSnapshot.components.map((c) => [c.productCode, c.qty])).toEqual([
      ['PRD-0001', 2], ['PRD-0002', 2], ['PRD-0009', 1],
    ]);
    expect((await masters.findById(created.id)).parts.map((p) => p.qtyPerBundle)).toEqual([2, 1]);
    expect((await masters.setStatus(created.id, { status: 'inactive' as never }, admin)).status).toBe('inactive');
  });

  it('extra costs, margin preview, edit under the same number, unbundle at original cost in its own series', async () => {
    const f = await fixtures();
    await recipe(f); // 2 dates (10) + 1 box (2) per pack, 1.50 packing per unit
    await move(f.dates._id, f.wh._id, 100);
    await move(f.box._id, f.wh._id, 50);
    const where = f.wh._id.toString();
    const labour = (amount: number) => [{ label: 'Labour', amount }];

    // parts 10 x 22 = 220, extra 10 x 1.50 + 30 = 45 -> 265 / 10 = 26.5; +20% = 31.80
    const preview = (await bundling.preview({ locationId: where, qty: 10, productId: f.gift._id.toString(), extraCosts: labour(30), marginPercent: 20 }, admin)) as Record<string, any>;
    expect(preview).toMatchObject({ totalCost: 265, costPerBundle: 26.5, suggestedPrice: 31.8, expectedProfitPerBundle: 5.3, expectedProfitTotal: 53 });
    expect(preview.parts[0]).toMatchObject({ required: 20, onHandBefore: 100, onHandAfter: 80, short: 0, isShort: false });
    const blind = (await bundling.preview({ locationId: where, qty: 10, productId: f.gift._id.toString(), extraCosts: labour(30), marginPercent: 20 }, user('Blind', ['bundling:read']))) as Record<string, any>;
    expect(blind).not.toHaveProperty('suggestedPrice');
    expect(blind).not.toHaveProperty('totalCost');
    await expect(bundling.preview({ locationId: where, qty: 100, productId: f.gift._id.toString() }, admin)).resolves.toMatchObject({ maxBundles: 50 });
    await expect(
      bundling.create({ date: '2026-02-02', locationId: where, mode: BundlingMode.BUNDLE, bundleProductId: f.gift._id.toString(), qty: 60 }, admin),
    ).rejects.toThrow(/PRD-0002 .* needs 60, has 50, short by 10/);

    const made = await bundling.create(
      { date: '2026-02-02', locationId: where, mode: BundlingMode.BUNDLE, bundleProductId: f.gift._id.toString(), qty: 10, extraCosts: labour(30) },
      admin,
    );
    expect(made.voucherNo).toBe('BND-0001');
    expect(made.costPerUnit).toBe(26.5);

    const same = { date: '2026-02-02', locationId: where, qty: 10, extraCosts: labour(30) };
    await expect(bundling.edit(made.id, same, admin)).rejects.toThrow(/No changes/);
    const edited = await bundling.edit(made.id, { ...same, extraCosts: labour(50) }, admin);
    expect(edited.voucherNo).toBe('BND-0001');
    expect(edited.costPerUnit).toBe(28.5);
    expect(await qtyOf(f.dates._id, f.wh._id)).toBe(80);
    expect(await qtyOf(f.gift._id, f.wh._id)).toBe(10);
    expect(await model(AuditLog.name).countDocuments({ entityType: 'bundling', action: 'updated' })).toBe(1);

    // unbundle later, after the part price moved: parts come back at what they cost when bundled
    await model(Product.name).updateOne({ _id: f.dates._id }, { purchasePrice: 99 });
    const unbundled = await bundling.create(
      { date: '2026-02-03', locationId: where, mode: BundlingMode.UNBUNDLE, bundleProductId: f.gift._id.toString(), qty: 4 },
      admin,
    );
    expect(unbundled.voucherNo).toBe('UBD-0001');
    expect(unbundled.recipeSnapshot.components.map((c) => c.unitCost)).toEqual([10, 2]);
    expect(await qtyOf(f.dates._id, f.wh._id)).toBe(88);

    // 4 boxes were taken apart: editing the bundling would need 10 of them back out
    await expect(bundling.edit(made.id, { ...same, qty: 8 }, admin)).rejects.toThrow(/can't be edited: its stock was already used on UBD-0001/);
  });

  it('validates and versions a recipe', async () => {
    const f = await fixtures();
    const set = (components: { productId: string; qty: number }[], extra = 0) =>
      bundling.setRecipe(f.gift._id.toString(), { components, extraCostPerUnit: extra }, admin);
    await expect(set([{ productId: f.gift._id.toString(), qty: 1 }])).rejects.toThrow(/itself/);
    await expect(set([{ productId: f.service._id.toString(), qty: 1 }])).rejects.toThrow(/stock products/);
    await expect(
      bundling.setRecipe(f.service._id.toString(), { components: [{ productId: f.box._id.toString(), qty: 1 }], extraCostPerUnit: 0 }, admin),
    ).rejects.toThrow(/cannot be bundled/);
    // any stock product can be a bundle output
    await bundling.setRecipe(f.dates._id.toString(), { components: [{ productId: f.box._id.toString(), qty: 1 }], extraCostPerUnit: 0 }, admin);
    await recipe(f);
    await expect(recipe(f)).rejects.toThrow(/No changes/);
    const changed = await set([{ productId: f.dates._id.toString(), qty: 3 }]);
    expect(changed.version).toBe(2);
    expect(await model(AuditLog.name).countDocuments({ entityType: 'product', entityRef: 'PRD-0003' })).toBe(2);
  });

  it('bundles: parts out, boxes in at cost, price updated; unbundle and undo restore', async () => {
    const f = await fixtures();
    await recipe(f);
    await move(f.dates._id, f.wh._id, 100);
    await move(f.box._id, f.wh._id, 50);

    const made = await make(f, 10);
    expect(made.voucherNo).toBe('BND-0001');
    expect(made.costPerUnit).toBe(23.5);
    expect(await qtyOf(f.dates._id, f.wh._id)).toBe(80);
    expect(await qtyOf(f.box._id, f.wh._id)).toBe(40);
    expect(await qtyOf(f.gift._id, f.wh._id)).toBe(10);
    expect((await model<Product>(Product.name).findById(f.gift._id).lean())?.purchasePrice).toBe(23.5);

    // A later recipe change leaves the past bundling alone.
    await bundling.setRecipe(f.gift._id.toString(), { components: [{ productId: f.dates._id.toString(), qty: 5 }], extraCostPerUnit: 0 }, admin);
    expect((await bundling.findById(made.id, admin)).recipeSnapshot.components).toHaveLength(2);

    await make(f, 4, BundlingMode.UNBUNDLE);
    expect(await qtyOf(f.gift._id, f.wh._id)).toBe(6);
    expect(await qtyOf(f.dates._id, f.wh._id)).toBe(100); // unbundle uses the current recipe (5 per pack)

    // Undo the bundling: boxes 6 left, undo needs 10 out -> blocked, nothing changes.
    await expect(bundling.cancel(made.id, { reason: 'wrong count' }, admin)).rejects.toThrow(/Bundling BND-0001 can't be undone: its stock was already used on UBD-0001/);
    expect(await qtyOf(f.gift._id, f.wh._id)).toBe(6);
    expect((await bundling.findById(made.id, admin)).status).toBe('posted');
  });

  it('undo restores everything when the boxes are still there', async () => {
    const f = await fixtures();
    await recipe(f);
    await move(f.dates._id, f.wh._id, 100);
    await move(f.box._id, f.wh._id, 50);
    const made = await make(f, 10);
    expect((await bundling.cancel(made.id, { reason: 'wrong count' }, admin)).status).toBe('cancelled');
    expect(await qtyOf(f.dates._id, f.wh._id)).toBe(100);
    expect(await qtyOf(f.box._id, f.wh._id)).toBe(50);
    expect(await qtyOf(f.gift._id, f.wh._id)).toBe(0);
    const entries = await model<{ productId: Types.ObjectId; locationId: Types.ObjectId; qty: number }>(StockEntry.name).find().lean();
    for (const product of [f.dates, f.box, f.gift]) {
      const sum = entries.filter((e) => e.productId.equals(product._id)).reduce((s, e) => s + e.qty, 0);
      expect(await qtyOf(product._id, f.wh._id)).toBe(sum);
    }
  });

  it('blocks a short component and reports the max makeable', async () => {
    const f = await fixtures();
    await recipe(f);
    await move(f.dates._id, f.wh._id, 25); // 12 packs worth
    await move(f.box._id, f.wh._id, 50);
    await expect(make(f, 15)).rejects.toThrow(/PRD-0001.*needs 30, has 25.*Max you can make: 12/);
    const check = await bundling.availability(f.gift._id.toString(), { locationId: f.wh._id.toString(), qty: 15 }, admin);
    expect(check.maxBundles).toBe(12);
    expect(check.components.find((c) => c.productCode === 'PRD-0001')).toMatchObject({ requiredPerUnit: 2, requiredTotal: 30, available: 25, short: 5 });
    expect(await qtyOf(f.dates._id, f.wh._id)).toBe(25);
  });

  it('keeps the product type locked once a recipe exists', async () => {
    const f = await fixtures();
    await recipe(f);
    expect(await moduleRef.get(ProductUsageRegistry).isProductUsed(f.box._id)).toBe(true);
    expect(await moduleRef.get(ProductUsageRegistry).isProductUsed(f.service._id)).toBe(false);
  });

  it('needs bundling permissions; the van salesman has none', async () => {
    const f = await fixtures();
    tokenUser = user('Van', [...VAN_SALESMAN_PERMISSIONS]);
    expect((await request(app.getHttpServer()).get('/bundlings')).status).toBe(403);
    expect((await request(app.getHttpServer()).put(`/products/${f.gift._id.toString()}/recipe`).send({})).status).toBe(403);
    tokenUser = admin;
    await recipe(f);
    await move(f.dates._id, f.wh._id, 10);
    await move(f.box._id, f.wh._id, 10);
    const made = await make(f, 1);
    const pdf = await request(app.getHttpServer()).get(`/bundlings/${made.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect((await request(app.getHttpServer()).get('/bundlings?mode=bundle')).body.items).toHaveLength(1);
  });

  describe('compose workspace', () => {
    async function setup() {
      const f = await fixtures();
      // Fixture products were inserted by hand: move the PRD counter past them.
      await model(Counter.name).collection.insertOne({ key: 'product', seq: 10 });
      const unit = (await model(Unit.name).findOne().lean()) as unknown as Ref;
      const compose = (over: Record<string, unknown> = {}, actor: AuthenticatedUser = admin) =>
        bundling.compose(
          {
            mode: BundlingMode.BUNDLE,
            locationId: f.wh._id.toString(),
            date: '2026-02-02',
            qty: 0,
            product: { new: { name: 'Mega Gift', unitId: unit._id.toString() } },
            parts: [
              { productId: f.dates._id.toString(), qtyPerBundle: 2 },
              { productId: f.box._id.toString(), qtyPerBundle: 1 },
            ],
            extraCostPerUnit: 1.5,
            ...over,
          } as never,
          actor,
        );
      return { f, compose, unit };
    }
    const counts = async () => ({
      products: await model(Product.name).countDocuments({ name: 'Mega Gift' }),
      recipes: await model(BundleRecipe.name).countDocuments(),
      bundlings: await model(Bundling.name).countDocuments(),
    });

    it('creates the product, its recipe and the bundling with FIFO cost, one correlation id', async () => {
      const { f, compose } = await setup();
      await move(f.dates._id, f.wh._id, 100);
      await move(f.box._id, f.wh._id, 50);
      const result = await compose({ qty: 10 });
      expect(result.bundling?.costPerUnit).toBe(23.5);
      expect(result.recipe?.version).toBe(1);
      const product = await model<Product>(Product.name).findById(result.product.id).lean();
      expect(product?.type).toBe(ProductType.STOCK);
      expect(await qtyOf(f.dates._id, f.wh._id)).toBe(80);
      expect(await qtyOf(new Types.ObjectId(result.product.id), f.wh._id)).toBe(10);
      const audit = await model<{ entityType: string }>(AuditLog.name).find({ correlationId: result.correlationId }).lean();
      expect(new Set(audit.map((entry) => entry.entityType))).toEqual(new Set(['product', 'bundling']));
      expect(audit.length).toBeGreaterThanOrEqual(3);
    });

    it('a shortage rolls back the new product and recipe', async () => {
      const { f, compose } = await setup();
      await move(f.dates._id, f.wh._id, 1);
      await expect(compose({ qty: 5 })).rejects.toThrow(/Not enough parts/);
      expect(await counts()).toEqual({ products: 0, recipes: 0, bundlings: 0 });
    });

    it('qty 0 saves the product and recipe only', async () => {
      const { f, compose } = await setup();
      await move(f.dates._id, f.wh._id, 10);
      const result = await compose({ qty: 0 });
      expect(result.bundling).toBeNull();
      expect(await counts()).toEqual({ products: 1, recipes: 1, bundlings: 0 });
      expect(await qtyOf(f.dates._id, f.wh._id)).toBe(10);
    });

    it('an existing product with a recipe packs without parts', async () => {
      const { f, compose } = await setup();
      await recipe(f);
      await move(f.dates._id, f.wh._id, 20);
      await move(f.box._id, f.wh._id, 10);
      const result = await compose({ product: { id: f.gift._id.toString() }, parts: undefined, qty: 3 });
      expect(result.bundling?.costPerUnit).toBe(23.5);
      expect(await qtyOf(f.gift._id, f.wh._id)).toBe(3);
    });

    it('refuses a missing permission and leaves nothing behind', async () => {
      const { compose } = await setup();
      const clerk = user('Clerk', ['bundling:create', 'bundles:manage']);
      await expect(compose({ qty: 1 }, clerk)).rejects.toThrow(/products:manage/);
      expect(await counts()).toEqual({ products: 0, recipes: 0, bundlings: 0 });
    });

    it('preview cost matches the posted cost; costs hidden without products:view-cost', async () => {
      const { f, compose } = await setup();
      await move(f.dates._id, f.wh._id, 100);
      await move(f.box._id, f.wh._id, 50);
      const input = {
        locationId: f.wh._id.toString(),
        qty: 10,
        parts: [
          { productId: f.dates._id.toString(), qtyPerBundle: 2 },
          { productId: f.box._id.toString(), qtyPerBundle: 1 },
        ],
        extraCostPerUnit: 1.5,
      };
      const preview = await bundling.preview(input, admin);
      expect(preview.maxBundles).toBe(50);
      const posted = await compose({ qty: 10 });
      expect(preview.costPerUnit).toBe(posted.bundling?.costPerUnit);
      const blind = await bundling.preview(input, user('Blind', ['bundling:read']));
      expect(blind).not.toHaveProperty('costPerUnit');
    });
  });
});
