import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Types, type Connection, type Model } from 'mongoose';
import { runInTransaction } from '../../common/utils/transaction.util.js';
import request from 'supertest';
import { mongooseTestRoot } from '../../../test/mongo-test-db.js';
import { StockService } from './stock.service.js';
import { StockController } from './stock.controller.js';
import { StockEntry, StockEntrySchema } from './schemas/stock-entry.schema.js';
import { StockBalance, StockBalanceSchema } from './schemas/stock-balance.schema.js';
import { OpeningStockService } from './opening-stock/opening-stock.service.js';
import { OpeningStockController } from './opening-stock/opening-stock.controller.js';
import { OpeningStock, OpeningStockSchema } from './opening-stock/schemas/opening-stock.schema.js';
import { Product, ProductSchema, ProductType } from '../product/products/schemas/product.schema.js';
import { ProductService } from '../product/products/product.service.js';
import { ProductUsageRegistry } from '../product/products/product-usage.registry.js';
import { ProductGroup, ProductGroupSchema } from '../product/product-groups/schemas/product-group.schema.js';
import { Unit, UnitSchema } from '../product/units/schemas/unit.schema.js';
import { Location, LocationSchema, LocationType, LocationStatus } from '../location/schemas/location.schema.js';
import { CompanyService } from '../company/company.service.js';
import { SequenceService } from '../sequence/sequence.service.js';
import { Counter, CounterSchema } from '../sequence/schemas/counter.schema.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditLog, AuditLogSchema } from '../audit/schemas/audit-log.schema.js';
import { CommentsService } from '../comments/comments.service.js';
import { EntityAccessRegistry } from '../comments/entity-access.registry.js';
import { Comment, CommentSchema } from '../comments/schemas/comment.schema.js';
import { FilesService } from '../files/files.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { createAppValidationPipe } from '../../common/pipes/app-validation.pipe.js';
import { configureHttpApp } from '../../common/http/configure-http-app.js';
import { ACCOUNTANT_PERMISSIONS, ADMIN_PERMISSIONS, DataScope, Permission } from '../roles/permissions.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';

const user = (name: string, permissions: string[] = [...ADMIN_PERMISSIONS], extra: Partial<AuthenticatedUser> = {}) => ({
  id: new Types.ObjectId().toString(),
  email: `${name.toLowerCase()}@example.com`,
  name,
  role: { id: new Types.ObjectId().toString(), name: 'r' },
  permissions,
  ...extra,
});

describe('Stock engine and opening stock', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let stock: StockService;
  let opening: OpeningStockService;
  let products: ProductService;
  const company = { allowNegativeStock: false };
  const admin = user('Admin');
  let tokenUser: AuthenticatedUser = admin;
  const model = <T>(name: string) => moduleRef.get<Model<T>>(getModelToken(name));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('stock'),
        MongooseModule.forFeature([
          { name: StockEntry.name, schema: StockEntrySchema },
          { name: StockBalance.name, schema: StockBalanceSchema },
          { name: OpeningStock.name, schema: OpeningStockSchema },
          { name: Product.name, schema: ProductSchema },
          { name: ProductGroup.name, schema: ProductGroupSchema },
          { name: Unit.name, schema: UnitSchema },
          { name: Location.name, schema: LocationSchema },
          { name: Counter.name, schema: CounterSchema },
          { name: AuditLog.name, schema: AuditLogSchema },
          { name: Comment.name, schema: CommentSchema },
        ]),
      ],
      controllers: [StockController, OpeningStockController],
      providers: [
        StockService,
        OpeningStockService,
        ProductService,
        ProductUsageRegistry,
        SequenceService,
        AuditService,
        CommentsService,
        EntityAccessRegistry,
        { provide: CompanyService, useValue: { ensure: async () => company } },
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
    stock = moduleRef.get(StockService);
    opening = moduleRef.get(OpeningStockService);
    products = moduleRef.get(ProductService);
    await Promise.all(
      [StockEntry, StockBalance, OpeningStock, Product, Location, Counter, AuditLog].map((m) => model(m.name).init()),
    );
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    company.allowNegativeStock = false;
    tokenUser = admin;
    await Promise.all(
      [StockEntry, StockBalance, OpeningStock, Product, ProductGroup, Unit, Location, Counter, AuditLog, Comment].map(
        (m) => model(m.name).collection.deleteMany({}),
      ),
    );
  });

  async function fixtures() {
    const group = await model(ProductGroup.name).create({ code: 'PG-0001', name: 'Dates' });
    const unit = await model(Unit.name).create({ name: 'Kilogram', symbol: 'kg' });
    type Ref = { _id: Types.ObjectId };
    const loc = async (code: string, type: LocationType, status = LocationStatus.ACTIVE) =>
      (await model<Location>(Location.name).create({ code, name: `${code} name`, type, status })) as unknown as Ref;
    const prd = async (code: string, type = ProductType.STOCK, extra = {}) =>
      (await model<Product>(Product.name).create({
        code,
        name: `${code} name`,
        productGroupId: group._id as Types.ObjectId,
        unitId: unit._id as Types.ObjectId,
        type,
        purchasePrice: 10,
        ...extra,
      })) as unknown as Ref;
    return {
      wh: await loc('WH-0001', LocationType.WAREHOUSE),
      van: await loc('VAN-0001', LocationType.VAN),
      branch: await loc('BR-0001', LocationType.BRANCH),
      ajwa: await prd('PRD-0001', ProductType.STOCK, { minStock: 5, reorderLevel: 20 }),
      gift: await prd('PRD-0002', ProductType.BUNDLE),
      service: await prd('PRD-0003', ProductType.NON_STOCK),
    };
  }

  const create = (locationId: Types.ObjectId, lines: { productId: Types.ObjectId; qty: number; unitCost?: number }[]) =>
    opening.create(
      {
        asOfDate: '2026-01-01',
        locationId: locationId.toString(),
        lines: lines.map((line) => ({ ...line, productId: line.productId.toString() })),
      },
      admin,
    );

  const qtyOf = async (productId: Types.ObjectId, locationId: Types.ObjectId) =>
    ((await model<{ qty: number }>(StockBalance.name).findOne({ productId, locationId }).lean().exec())?.qty ?? 0);

  /** A sale-like movement out of stock, posted straight through the engine. */
  const issue = (productId: Types.ObjectId, locationId: Types.ObjectId, qty: number) =>
    runInTransaction(moduleRef.get<Connection>(getConnectionToken()), (session) =>
      stock.post(
        [
          {
            productId,
            locationId,
            qty: -qty,
            date: new Date('2026-02-01'),
            voucherType: 'test-issue',
            voucherId: new Types.ObjectId(),
            voucherNo: 'T-1',
          },
        ],
        admin,
        session,
      ),
    );

  /** Every StockBalance equals the sum of its entries. */
  async function expectBalancesMatchEntries() {
    const sums = await model(StockEntry.name)
      .aggregate<{ _id: { p: Types.ObjectId; l: Types.ObjectId }; qty: number }>([
        { $group: { _id: { p: '$productId', l: '$locationId' }, qty: { $sum: '$qty' } } },
      ])
      .exec();
    const balances = await model<{ productId: Types.ObjectId; locationId: Types.ObjectId; qty: number }>(StockBalance.name)
      .find()
      .lean()
      .exec();
    expect(balances.length).toBe(sums.length);
    for (const balance of balances) {
      const sum = sums.find((row) => row._id.p.equals(balance.productId) && row._id.l.equals(balance.locationId));
      expect(Math.round(balance.qty * 1000) / 1000).toBe(Math.round((sum?.qty ?? 0) * 1000) / 1000);
    }
  }

  it('posts opening stock per location; the summary equals the sum of entries', async () => {
    const { wh, van, ajwa, gift } = await fixtures();
    const os = await create(wh._id, [
      { productId: ajwa._id, qty: 30, unitCost: 12 },
      { productId: gift._id, qty: 4 },
    ]);
    await create(van._id, [{ productId: ajwa._id, qty: 2.5 }]);

    expect(os.voucherNo).toBe('OS-0001');
    expect(await qtyOf(ajwa._id, wh._id)).toBe(30);
    expect(await qtyOf(ajwa._id, van._id)).toBe(2.5);
    await expectBalancesMatchEntries();

    const summary = await stock.summary({}, admin);
    const row = summary.items.find((item) => item.code === 'PRD-0001')!;
    expect(row).toMatchObject({ total: 32.5, status: 'ok', value: 325, unit: { symbol: 'kg' }, group: { name: 'Dates' } });
    expect(row.byLocation.map((l) => l.qty).sort()).toEqual([2.5, 30]);
    expect(summary.items.map((item) => item.code)).toEqual(['PRD-0001', 'PRD-0002']);

    const history = await stock.history({ productId: ajwa._id.toString() }, admin);
    expect(history.items.map((item) => item.balance)).toEqual([30, 32.5]);
    expect(history.items[0]).toMatchObject({ in: 30, out: 0, voucherNo: 'OS-0001', by: { name: 'Admin' } });

    // No cost without products:view-cost; low stock after an issue.
    await issue(ajwa._id, wh._id, 15);
    const low = await stock.summary({ lowStock: true }, user('Clerk', [Permission.STOCK_READ]));
    expect(low.items).toHaveLength(1);
    expect(low.items[0]).toMatchObject({ code: 'PRD-0001', total: 17.5, status: 'reorder' });
    expect(low.items[0].value).toBeUndefined();
  });

  it('rejects a duplicate product+location line, naming the existing voucher', async () => {
    const { wh, van, ajwa } = await fixtures();
    await create(wh._id, [{ productId: ajwa._id, qty: 10 }]);

    await expect(create(wh._id, [{ productId: ajwa._id, qty: 1 }])).rejects.toThrow(
      'Line 1: PRD-0001 (PRD-0001 name) already has opening stock at this location on OS-0001',
    );
    await expect(
      create(van._id, [
        { productId: ajwa._id, qty: 1 },
        { productId: ajwa._id, qty: 2 },
      ]),
    ).rejects.toThrow('Line 2: PRD-0001 (PRD-0001 name) is on more than one line');
    // Another location is fine.
    await create(van._id, [{ productId: ajwa._id, qty: 1 }]);
    expect(await qtyOf(ajwa._id, wh._id)).toBe(10);
  });

  it('only active warehouse/store/van locations and stock/bundle products hold stock', async () => {
    const { branch, wh, service, ajwa } = await fixtures();
    await expect(create(branch._id, [{ productId: ajwa._id, qty: 1 }])).rejects.toThrow('only warehouses, stores and vans');
    await expect(create(wh._id, [{ productId: service._id, qty: 1 }])).rejects.toThrow('non_stock product and holds no stock');
    await model(Location.name).updateOne({ _id: wh._id }, { status: LocationStatus.INACTIVE }).exec();
    await expect(create(wh._id, [{ productId: ajwa._id, qty: 1 }])).rejects.toThrow('is inactive');
  });

  it('blocks negative results unless the company allows them; cancel is always strict', async () => {
    const { wh, ajwa } = await fixtures();
    const os = await create(wh._id, [{ productId: ajwa._id, qty: 10 }]);

    await expect(issue(ajwa._id, wh._id, 11)).rejects.toThrow('Not enough stock: PRD-0001 (PRD-0001 name) at WH-0001 (WH-0001 name) would be -1');
    expect(await qtyOf(ajwa._id, wh._id)).toBe(10);

    await issue(ajwa._id, wh._id, 4);
    await expect(opening.cancel(os.id, { reason: 'Wrong count' }, admin)).rejects.toThrow('Not enough stock');
    company.allowNegativeStock = true;
    await issue(ajwa._id, wh._id, 8);
    expect(await qtyOf(ajwa._id, wh._id)).toBe(-2);
    await expect(opening.cancel(os.id, { reason: 'Wrong count' }, admin)).rejects.toThrow('Not enough stock');
    await expectBalancesMatchEntries();
  });

  it('cancel restores balances; edit reverses and reposts on the net result', async () => {
    const { wh, van, ajwa, gift } = await fixtures();
    const os = await create(wh._id, [{ productId: ajwa._id, qty: 10 }]);
    await issue(ajwa._id, wh._id, 9);

    // 10 -> 12 would dip below zero mid-way if reversal and repost were checked separately.
    await opening.update(os.id, { lines: [{ productId: ajwa._id.toString(), qty: 12 }] }, admin);
    expect(await qtyOf(ajwa._id, wh._id)).toBe(3);
    await expect(opening.update(os.id, { lines: [{ productId: ajwa._id.toString(), qty: 12 }] }, admin)).rejects.toThrow(
      'No changes to save',
    );

    const other = await create(van._id, [{ productId: gift._id, qty: 5 }]);
    await opening.update(other.id, { locationId: wh._id.toString() }, admin);
    expect(await qtyOf(gift._id, van._id)).toBe(0);
    expect(await qtyOf(gift._id, wh._id)).toBe(5);
    await opening.cancel(other.id, { reason: 'Duplicate' }, admin);
    expect(await qtyOf(gift._id, wh._id)).toBe(0);
    await expectBalancesMatchEntries();

    const audit = await model(AuditLog.name).findOne({ entityId: os._id, action: 'updated' }).lean().exec();
    expect((audit as unknown as { changes: unknown[] }).changes).toEqual([
      expect.objectContaining({ label: 'PRD-0001 name', from: '10', to: '12' }),
    ]);
  });

  it('a scoped user sees stock only for their locations', async () => {
    const { wh, van, ajwa } = await fixtures();
    await create(wh._id, [{ productId: ajwa._id, qty: 10 }]);
    await create(van._id, [{ productId: ajwa._id, qty: 3 }]);
    const salesman = user('Salesman', [Permission.STOCK_READ, Permission.OPENING_STOCK_READ], {
      dataScope: DataScope.OWN,
      allowedLocationIds: [van._id.toString()],
    });

    const summary = await stock.summary({}, salesman);
    expect(summary.items[0]).toMatchObject({ total: 3, byLocation: [{ locationId: van._id.toString(), qty: 3 }] });
    expect((await stock.history({ productId: ajwa._id.toString() }, salesman)).items.map((i) => i.in)).toEqual([3]);
    await expect(stock.summary({ locationId: wh._id.toString() }, salesman)).rejects.toThrow('may not see stock');
    expect((await opening.findAll({}, salesman)).items.map((item) => item.voucherNo)).toEqual(['OS-0002']);

    tokenUser = salesman;
    await request(app.getHttpServer()).get(`/stock/summary?locationId=${wh._id.toString()}`).expect(403);
    tokenUser = user('Accountant', [...ACCOUNTANT_PERMISSIONS]);
    await request(app.getHttpServer())
      .post('/opening-stock')
      .send({ asOfDate: '2026-01-01', locationId: wh._id.toString(), lines: [{ productId: ajwa._id.toString(), qty: 1 }] })
      .expect(403);
    await request(app.getHttpServer()).get('/stock/summary?lowStock=false').expect(200);
  });

  it('validate resolves product codes and reports row errors without posting', async () => {
    const { wh, ajwa } = await fixtures();
    await create(wh._id, [{ productId: ajwa._id, qty: 1 }]);
    const result = await opening.validate(
      {
        locationId: wh._id.toString(),
        lines: [
          { productCode: 'prd-0002', qty: 4 },
          { productCode: 'NOPE', qty: 1 },
          { productCode: 'PRD-0003', qty: 1 },
          { productCode: 'PRD-0002', qty: 0 },
          { productCode: 'PRD-0001', qty: 2 },
        ],
      },
      admin,
    );
    expect(result.valid).toBe(false);
    expect(result.lines[0]).toMatchObject({ row: 1, productCode: 'PRD-0002', qty: 4 });
    expect(result.errors.map((e) => `${e.row}: ${e.message}`)).toEqual([
      '2: Unknown product code "NOPE"',
      '3: PRD-0003 (PRD-0003 name) is a non_stock product and holds no stock',
      '4: PRD-0002 (PRD-0002 name) is on more than one line',
      '4: Quantity must be greater than 0',
      '5: PRD-0001 (PRD-0001 name) already has opening stock at this location on OS-0001',
    ]);
    expect(await model(StockEntry.name).countDocuments()).toBe(1);
  });

  it("locks a product's type once it has stock entries", async () => {
    const { wh, ajwa } = await fixtures();
    await create(wh._id, [{ productId: ajwa._id, qty: 1 }]);
    expect(await products.isProductUsed(ajwa._id)).toBe(true);
    await expect(products.update(ajwa._id.toString(), { type: ProductType.BUNDLE }, admin)).rejects.toThrow(
      'cannot change: it is used by stock entries',
    );
  });
});
