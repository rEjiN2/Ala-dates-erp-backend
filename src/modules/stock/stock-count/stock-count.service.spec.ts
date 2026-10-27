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
import { StockCountService } from './stock-count.service.js';
import { StockCountController } from './stock-count.controller.js';
import { StockCount, StockCountSchema } from './schemas/stock-count.schema.js';
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
import { ADMIN_PERMISSIONS, DataScope, VAN_SALESMAN_PERMISSIONS } from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';

const user = (name: string, permissions: string[] = [...ADMIN_PERMISSIONS], extra: Partial<AuthenticatedUser> = {}) => ({
  id: new Types.ObjectId().toString(),
  email: `${name.toLowerCase()}@example.com`,
  name,
  role: { id: new Types.ObjectId().toString(), name: 'r' },
  permissions,
  ...extra,
});

describe('Stock count', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let counts: StockCountService;
  let stock: StockService;
  const company = { allowNegativeStock: false };
  const counter = user('Counter');
  const approver = user('Approver');
  let tokenUser: AuthenticatedUser = approver;
  const model = <T>(name: string) => moduleRef.get<Model<T>>(getModelToken(name));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('stock_count'),
        MongooseModule.forFeature([
          { name: StockEntry.name, schema: StockEntrySchema },
          { name: StockBalance.name, schema: StockBalanceSchema },
          { name: StockCount.name, schema: StockCountSchema },
          { name: Product.name, schema: ProductSchema },
          { name: ProductGroup.name, schema: ProductGroupSchema },
          { name: Unit.name, schema: UnitSchema },
          { name: Location.name, schema: LocationSchema },
          { name: Counter.name, schema: CounterSchema },
          { name: AuditLog.name, schema: AuditLogSchema },
          { name: Comment.name, schema: CommentSchema },
        ]),
      ],
      controllers: [StockCountController],
      providers: [
        StockService,
        StockCountService,
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
    counts = moduleRef.get(StockCountService);
    stock = moduleRef.get(StockService);
    await Promise.all([StockEntry, StockBalance, StockCount, Product, Location, Counter, AuditLog].map((m) => model(m.name).init()));
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  afterEach(async () => {
    tokenUser = approver;
    await Promise.all(
      [StockEntry, StockBalance, StockCount, Product, ProductGroup, Unit, Location, Counter, AuditLog, Comment].map((m) =>
        model(m.name).collection.deleteMany({}),
      ),
    );
  });

  type Ref = { _id: Types.ObjectId };
  async function fixtures() {
    const group = await model(ProductGroup.name).create({ code: 'PG-0001', name: 'Dates' });
    const unit = await model(Unit.name).create({ name: 'Kilogram', symbol: 'kg' });
    const prd = async (code: string, type = ProductType.STOCK) =>
      (await model<Product>(Product.name).create({
        code,
        name: `${code} name`,
        productGroupId: group._id as Types.ObjectId,
        unitId: unit._id as Types.ObjectId,
        type,
        purchasePrice: 10,
      })) as unknown as Ref;
    const wh = (await model<Location>(Location.name).create({
      code: 'WH-0001',
      name: 'Main',
      type: LocationType.WAREHOUSE,
    })) as unknown as Ref;
    return { wh, ajwa: await prd('PRD-0001'), safawi: await prd('PRD-0002'), service: await prd('PRD-0003', ProductType.NON_STOCK) };
  }

  const move = (productId: Types.ObjectId, locationId: Types.ObjectId, qty: number, voucherNo = 'T-1') =>
    runInTransaction(moduleRef.get<Connection>(getConnectionToken()), (session) =>
      stock.post(
        [{ productId, locationId, qty, date: new Date('2026-02-01'), voucherType: 'test', voucherId: new Types.ObjectId(), voucherNo }],
        approver,
        session,
      ),
    );

  const qtyOf = async (productId: Types.ObjectId, locationId: Types.ObjectId) =>
    (await model<{ qty: number }>(StockBalance.name).findOne({ productId, locationId }).lean().exec())?.qty ?? 0;

  async function submitted(f: Awaited<ReturnType<typeof fixtures>>, countedQty: number) {
    const created = await counts.create(
      { date: '2026-02-02', locationId: f.wh._id.toString(), lines: [{ productId: f.ajwa._id.toString(), countedQty }] },
      counter,
    );
    return counts.submit(created.id, counter);
  }

  /** Every balance equals the sum of its entries. */
  async function expectBalancesMatchEntries() {
    const sums = await model(StockEntry.name)
      .aggregate<{ _id: { p: Types.ObjectId; l: Types.ObjectId }; qty: number }>([
        { $group: { _id: { p: '$productId', l: '$locationId' }, qty: { $sum: '$qty' } } },
      ])
      .exec();
    for (const sum of sums) expect(await qtyOf(sum._id.p, sum._id.l)).toBeCloseTo(sum.qty, 3);
  }

  it('posts -2 on approval when 18 is counted against 20, and cancel restores', async () => {
    const f = await fixtures();
    await move(f.ajwa._id, f.wh._id, 20);
    const sc = await submitted(f, 18);
    expect(sc.voucherNo).toBe('SC-0001');
    expect(sc.lines[0]).toMatchObject({ snapshotQty: 20, difference: -2 });

    const approved = await counts.approve(sc.id, {}, approver);
    expect(approved.status).toBe('approved');
    expect(await qtyOf(f.ajwa._id, f.wh._id)).toBe(18);

    const cancelled = await counts.cancel(sc.id, { reason: 'counted wrong' }, approver);
    expect(cancelled.status).toBe('cancelled');
    expect(await qtyOf(f.ajwa._id, f.wh._id)).toBe(20);
    await expectBalancesMatchEntries();
  });

  it('keeps movement after the snapshot, flagged, and needs acknowledgement', async () => {
    const f = await fixtures();
    await move(f.ajwa._id, f.wh._id, 20);
    const sc = await submitted(f, 18);
    await move(f.ajwa._id, f.wh._id, -5, 'T-2'); // a sale after the snapshot: 15 on hand

    expect((await counts.findById(sc.id, approver)).lines[0]).toMatchObject({ movedSinceCount: true });
    await expect(counts.approve(sc.id, {}, approver)).rejects.toThrow(/acknowledgeMoved/);
    expect(await qtyOf(f.ajwa._id, f.wh._id)).toBe(15);

    await counts.approve(sc.id, { acknowledgeMoved: true }, approver);
    expect(await qtyOf(f.ajwa._id, f.wh._id)).toBe(13); // 15 + (18 - 20)
    expect((await counts.findById(sc.id, approver)).lines[0]).toMatchObject({ movedSinceCount: true });
    await expectBalancesMatchEntries();
  });

  it('applies the negative-stock rule to the approval result and blocks a cancel that would go negative', async () => {
    const f = await fixtures();
    await move(f.ajwa._id, f.wh._id, 20);
    const sc = await submitted(f, 0); // -20
    await move(f.ajwa._id, f.wh._id, -19, 'T-2'); // 1 left
    await expect(counts.approve(sc.id, { acknowledgeMoved: true }, approver)).rejects.toThrow(/Not enough stock/);
    expect((await counts.findById(sc.id, approver)).status).toBe('submitted');

    await move(f.ajwa._id, f.wh._id, 19, 'T-3'); // back to 20
    await counts.approve(sc.id, { acknowledgeMoved: true }, approver);
    await expect(counts.cancel(sc.id, { reason: 'undo it' }, approver)).resolves.toMatchObject({ status: 'cancelled' });
    await expectBalancesMatchEntries();
  });

  it('rejects with a reason, posts nothing, and bars the submitter from approving', async () => {
    const f = await fixtures();
    await move(f.ajwa._id, f.wh._id, 20);
    const sc = await submitted(f, 18);
    await expect(counts.approve(sc.id, {}, counter)).rejects.toThrow(/submitted/);
    await expect(counts.reject(sc.id, { reason: 'recount please' }, counter)).rejects.toThrow(/submitted/);
    await expect(counts.reject(sc.id, { reason: 'not right' }, approver)).resolves.toMatchObject({ status: 'rejected' });
    expect(await qtyOf(f.ajwa._id, f.wh._id)).toBe(20);
    await expectBalancesMatchEntries();
  });

  it('needs every line counted to submit and only the creator edits a draft', async () => {
    const f = await fixtures();
    const draft = await counts.create(
      { date: '2026-02-02', locationId: f.wh._id.toString(), lines: [{ productId: f.ajwa._id.toString() }] },
      counter,
    );
    await expect(counts.submit(draft.id, counter)).rejects.toThrow(/Every line must be counted/);
    await expect(counts.update(draft.id, { comments: 'x' }, approver)).rejects.toThrow(/creator/);
    await expect(
      counts.create(
        { date: '2026-02-02', locationId: f.wh._id.toString(), lines: [{ productId: f.service._id.toString(), countedQty: 1 }] },
        counter,
      ),
    ).rejects.toThrow(/holds no stock/);
  });

  it('loads products with their snapshot and validates CSV lines by code', async () => {
    const f = await fixtures();
    await move(f.ajwa._id, f.wh._id, 7);
    const draft = await counts.create({ date: '2026-02-02', locationId: f.wh._id.toString() }, counter);
    const loaded = await counts.loadProducts(draft.id, { onlyWithStock: true }, counter);
    expect(loaded.lines).toHaveLength(1);

    const checked = await counts.validate(
      {
        locationId: f.wh._id.toString(),
        lines: [{ productCode: 'prd-0001', countedQty: 3 }, { productCode: 'NOPE' }, { productCode: 'PRD-0001' }],
      },
      approver,
    );
    expect(checked.valid).toBe(false);
    expect(checked.lines[0]).toMatchObject({ productId: f.ajwa._id.toString(), snapshotQty: 7 });
    expect(checked.errors.map((e) => e.row)).toEqual([2, 3]);
  });

  it('counts blind for a van salesman: no snapshot or difference, no approving', async () => {
    const f = await fixtures();
    await move(f.ajwa._id, f.wh._id, 20);
    const salesman = user('Salesman', [...VAN_SALESMAN_PERMISSIONS], {
      dataScope: DataScope.OWN,
      allowedLocationIds: [f.wh._id.toString()],
    });
    tokenUser = salesman;
    const created = await request(app.getHttpServer())
      .post('/stock-counts')
      .send({ date: '2026-02-02', locationId: f.wh._id.toString(), lines: [{ productId: f.ajwa._id.toString(), countedQty: 18 }] });
    expect(created.status).toBe(201);
    expect(created.body.lines[0]).not.toHaveProperty('snapshotQty');
    expect(created.body.lines[0]).not.toHaveProperty('difference');
    expect(created.body).not.toHaveProperty('totals');
    expect((await request(app.getHttpServer()).post(`/stock-counts/${created.body.id}/submit`)).status).toBe(201);
    expect((await request(app.getHttpServer()).post(`/stock-counts/${created.body.id}/approve`).send({})).status).toBe(403);
    expect((await request(app.getHttpServer()).get(`/stock-counts/${created.body.id}/pdf`)).status).toBe(200);
    expect((await request(app.getHttpServer()).get(`/stock-counts/${created.body.id}/adjustment-pdf`)).status).toBe(403);
  });
});
