import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Types, type Connection, type Model } from 'mongoose';
import request from 'supertest';
import { mongooseTestRoot } from '../../../../test/mongo-test-db.js';
import { StockService } from '../stock.service.js';
import { StockEntry, StockEntrySchema } from '../schemas/stock-entry.schema.js';
import { StockBalance, StockBalanceSchema } from '../schemas/stock-balance.schema.js';
import { BundlingService } from './bundling.service.js';
import { BundlingController } from './bundling.controller.js';
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
        BundlingService,
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
    await Promise.all([StockEntry, StockBalance, Bundling, BundleRecipe, Product, Location, Counter, AuditLog].map((m) => model(m.name).init()));
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
        [{ productId, locationId, qty, date: new Date('2026-02-01'), voucherType: 'test', voucherId: new Types.ObjectId(), voucherNo: 'T-1' }],
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

  it('validates and versions a recipe', async () => {
    const f = await fixtures();
    const set = (components: { productId: string; qty: number }[], extra = 0) =>
      bundling.setRecipe(f.gift._id.toString(), { components, extraCostPerUnit: extra }, admin);
    await expect(set([{ productId: f.gift._id.toString(), qty: 1 }])).rejects.toThrow(/itself/);
    await expect(set([{ productId: f.service._id.toString(), qty: 1 }])).rejects.toThrow(/stock products/);
    await expect(
      bundling.setRecipe(f.dates._id.toString(), { components: [{ productId: f.box._id.toString(), qty: 1 }], extraCostPerUnit: 0 }, admin),
    ).rejects.toThrow(/not a bundle/);
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
    await expect(bundling.cancel(made.id, { reason: 'wrong count' }, admin)).rejects.toThrow(/Cannot undo BND-0001/);
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
});
