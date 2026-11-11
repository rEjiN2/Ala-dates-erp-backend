import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Types, type Connection, type Model } from 'mongoose';
import { mongooseTestRoot } from '../../../../test/mongo-test-db.js';
import { StockService } from '../stock.service.js';
import { InTransitRegistry } from '../pending-receipt.js';
import { StockEntry, StockEntrySchema } from '../schemas/stock-entry.schema.js';
import { StockBalance, StockBalanceSchema } from '../schemas/stock-balance.schema.js';
import { StockTransferService } from './stock-transfer.service.js';
import { StockTransfer, StockTransferSchema } from './schemas/stock-transfer.schema.js';
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
import { ADMIN_PERMISSIONS, ADMIN_ROLE_NAME, DataScope, VAN_SALESMAN_PERMISSIONS } from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';

const user = (name: string, extra: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  id: new Types.ObjectId().toString(),
  email: `${name.toLowerCase()}@example.com`,
  name,
  role: { id: new Types.ObjectId().toString(), name: ADMIN_ROLE_NAME },
  permissions: [...ADMIN_PERMISSIONS],
  ...extra,
});

describe('StockTransfer', () => {
  let moduleRef: TestingModule;
  let transfers: StockTransferService;
  let stock: StockService;
  const admin = user('Admin');
  const model = <T>(name: string) => moduleRef.get<Model<T>>(getModelToken(name));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('stock-transfer'),
        MongooseModule.forFeature([
          { name: StockEntry.name, schema: StockEntrySchema },
          { name: StockBalance.name, schema: StockBalanceSchema },
          { name: StockTransfer.name, schema: StockTransferSchema },
          { name: Product.name, schema: ProductSchema },
          { name: ProductGroup.name, schema: ProductGroupSchema },
          { name: Unit.name, schema: UnitSchema },
          { name: Location.name, schema: LocationSchema },
          { name: Counter.name, schema: CounterSchema },
          { name: AuditLog.name, schema: AuditLogSchema },
          { name: Comment.name, schema: CommentSchema },
        ]),
      ],
      providers: [
        StockService,
        StockTransferService,
        InTransitRegistry,
        ProductService,
        ProductUsageRegistry,
        SequenceService,
        AuditService,
        CommentsService,
        EntityAccessRegistry,
        { provide: CompanyService, useValue: { ensure: async () => ({ allowNegativeStock: false }) } },
        { provide: FilesService, useValue: {} },
      ],
    }).compile();
    await moduleRef.init();
    transfers = moduleRef.get(StockTransferService);
    stock = moduleRef.get(StockService);
    await Promise.all(
      [StockEntry, StockBalance, StockTransfer, Product, Location, Counter, AuditLog].map((m) => model(m.name).init()),
    );
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  afterEach(async () => {
    await Promise.all(
      [StockEntry, StockBalance, StockTransfer, Product, ProductGroup, Unit, Location, Counter, AuditLog, Comment].map((m) =>
        model(m.name).collection.deleteMany({}),
      ),
    );
  });

  type Ref = { _id: Types.ObjectId };
  async function fixtures() {
    const group = await model(ProductGroup.name).create({ code: 'PG-0001', name: 'Dates' });
    const unit = await model(Unit.name).create({ name: 'Piece', symbol: 'pc' });
    const prd = async (code: string, type: ProductType) =>
      (await model<Product>(Product.name).create({
        code,
        name: `${code} name`,
        productGroupId: group._id as Types.ObjectId,
        unitId: unit._id as Types.ObjectId,
        type,
        purchasePrice: 5,
      })) as unknown as Ref;
    const loc = async (code: string, type: LocationType) =>
      (await model<Location>(Location.name).create({ code, name: code, type })) as unknown as Ref;
    return {
      wh: await loc('WH-0001', LocationType.WAREHOUSE),
      van1: await loc('VAN-0001', LocationType.VAN),
      van2: await loc('VAN-0002', LocationType.VAN),
      branch: await loc('BR-0001', LocationType.BRANCH),
      dates: await prd('PRD-0001', ProductType.STOCK),
      box: await prd('PRD-0002', ProductType.STOCK),
      service: await prd('PRD-0003', ProductType.NON_STOCK),
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

  /** Every StockBalance equals the sum of its entries. */
  async function expectBalancesMatchEntries() {
    const sums = await model(StockEntry.name)
      .aggregate<{ _id: { p: Types.ObjectId; l: Types.ObjectId }; qty: number }>([
        { $group: { _id: { p: '$productId', l: '$locationId' }, qty: { $sum: '$qty' } } },
      ])
      .exec();
    const balances = await model<{ productId: Types.ObjectId; locationId: Types.ObjectId; qty: number }>(StockBalance.name).find().lean().exec();
    for (const sum of sums) {
      const balance = balances.find((b) => b.productId.equals(sum._id.p) && b.locationId.equals(sum._id.l));
      expect(balance?.qty ?? 0).toBeCloseTo(sum.qty, 3);
    }
    for (const balance of balances) {
      const sum = sums.find((s) => balance.productId.equals(s._id.p) && balance.locationId.equals(s._id.l));
      expect(balance.qty).toBeCloseTo(sum?.qty ?? 0, 3);
    }
  }

  const send = (f: Fx, qty: number, actor = admin, from = f.wh, to = f.van1) =>
    transfers.create(
      {
        date: '2026-02-02',
        fromLocationId: from._id.toString(),
        toLocationId: to._id.toString(),
        lines: [{ productId: f.dates._id.toString(), qty }],
      },
      actor,
    );

  const summaryRow = async (f: Fx, viewer = admin) =>
    (await stock.summary({}, viewer)).items.find((row) => row.productId === f.dates._id.toString())!;

  it('send reduces the source and shows in transit; receive adds to the destination', async () => {
    const f = await fixtures();
    await move(f.dates._id, f.wh._id, 100);

    const sent = await send(f, 30);
    expect(sent.voucherNo).toBe('TR-0001');
    expect(sent.status).toBe('in_transit');
    expect(await qtyOf(f.dates._id, f.wh._id)).toBe(70);
    expect(await qtyOf(f.dates._id, f.van1._id)).toBe(0);
    let row = await summaryRow(f);
    expect([row.total, row.inTransit, row.grandTotal]).toEqual([70, 30, 100]);

    const received = await transfers.receive(sent.id, {}, admin);
    expect(received.status).toBe('received');
    expect(received.lines[0].receivedQty).toBe(30);
    expect(await qtyOf(f.dates._id, f.van1._id)).toBe(30);
    row = await summaryRow(f);
    expect([row.total, row.inTransit, row.grandTotal]).toEqual([100, 0, 100]);
    await expect(transfers.receive(sent.id, {}, admin)).rejects.toThrow(/received and cannot be received/);
    await expectBalancesMatchEntries();
  });

  it('a shortfall goes back to the source and needs a reason', async () => {
    const f = await fixtures();
    await move(f.dates._id, f.wh._id, 100);
    const sent = await send(f, 30);
    const lines = [{ productId: f.dates._id.toString(), receivedQty: 25 }];

    await expect(transfers.receive(sent.id, { lines }, admin)).rejects.toThrow(/reason is required/);
    await expect(
      transfers.receive(sent.id, { lines: [{ ...lines[0], receivedQty: 31 }], shortfallReason: 'x' }, admin),
    ).rejects.toThrow(/between 0 and 30/);
    expect(await qtyOf(f.dates._id, f.van1._id)).toBe(0);

    const received = await transfers.receive(sent.id, { lines, shortfallReason: 'spilled in the van' }, admin);
    expect(received.shortfallReason).toBe('spilled in the van');
    expect(await qtyOf(f.dates._id, f.van1._id)).toBe(25);
    expect(await qtyOf(f.dates._id, f.wh._id)).toBe(75);
    await expectBalancesMatchEntries();
  });

  it('cancel restores the source, only while in transit; edit reverses and reposts', async () => {
    const f = await fixtures();
    await move(f.dates._id, f.wh._id, 100);

    const sent = await send(f, 30);
    await expect(
      transfers.update(sent.id, { lines: [{ productId: f.dates._id.toString(), qty: 30 }] }, admin),
    ).rejects.toThrow(/No changes/);
    const edited = await transfers.update(sent.id, { lines: [{ productId: f.dates._id.toString(), qty: 40 }], changeNote: 'more' }, admin);
    expect(edited.totalQty).toBe(40);
    expect(await qtyOf(f.dates._id, f.wh._id)).toBe(60);
    // Not the sender and not admin.
    const other = user('Other', { role: { id: 'r', name: 'Clerk' } });
    await expect(transfers.update(sent.id, { comments: 'hi' }, other)).rejects.toThrow(/sender or an administrator/);

    await expect(transfers.cancel(sent.id, { reason: 'x' }, admin)).resolves.toMatchObject({ status: 'cancelled' });
    expect(await qtyOf(f.dates._id, f.wh._id)).toBe(100);
    expect((await summaryRow(f)).inTransit).toBe(0);
    await expect(transfers.cancel(sent.id, { reason: 'again' }, admin)).rejects.toThrow(/cancelled and cannot be cancelled/);

    const second = await send(f, 10);
    await transfers.receive(second.id, {}, admin);
    await expect(transfers.cancel(second.id, { reason: 'late' }, admin)).rejects.toThrow(/received and cannot be cancelled/);
    await expect(transfers.update(second.id, { comments: 'late' }, admin)).rejects.toThrow(/cannot be edited/);
    await expectBalancesMatchEntries();
  });

  it('validates locations, products, quantities and the negative-stock rule', async () => {
    const f = await fixtures();
    await move(f.dates._id, f.wh._id, 10);
    const lines = [{ productId: f.dates._id.toString(), qty: 5 }];
    const make = (patch: object) =>
      transfers.create({ date: '2026-02-02', fromLocationId: f.wh._id.toString(), toLocationId: f.van1._id.toString(), lines, ...patch }, admin);

    await expect(make({ toLocationId: f.wh._id.toString() })).rejects.toThrow(/different locations/);
    await expect(make({ toLocationId: f.branch._id.toString() })).rejects.toThrow(/only warehouses, stores and vans/);
    await expect(make({ lines: [{ productId: f.service._id.toString(), qty: 1 }] })).rejects.toThrow(/holds no stock/);
    await expect(make({ lines: [lines[0], lines[0]] })).rejects.toThrow(/more than one line/);
    await expect(make({ date: '2999-01-01' })).rejects.toThrow(/future/);
    await expect(make({ lines: [{ productId: f.dates._id.toString(), qty: 11 }] })).rejects.toThrow(/Not enough stock/);
    expect(await model(StockTransfer.name).countDocuments()).toBe(0);
    expect(await qtyOf(f.dates._id, f.wh._id)).toBe(10);
    await expectBalancesMatchEntries();
  });

  it('scoped users send only from, and receive only into, their own locations (never their own transfer)', async () => {
    const f = await fixtures();
    await move(f.dates._id, f.wh._id, 100);
    await move(f.dates._id, f.van1._id, 20);
    const salesman = (name: string, locations: Types.ObjectId[]) =>
      user(name, {
        role: { id: 'r', name: 'Van Salesman' },
        permissions: [...VAN_SALESMAN_PERMISSIONS],
        dataScope: DataScope.OWN,
        allowedLocationIds: locations.map((id) => id.toString()),
      });
    const ali = salesman('Ali', [f.van1._id]);
    const omar = salesman('Omar', [f.van2._id]);

    await expect(send(f, 5, ali, f.wh, f.van1)).rejects.toThrow(/may not send stock from/);
    const toOffice = await send(f, 5, ali, f.van1, f.wh);
    const fromOffice = await send(f, 7, admin, f.wh, f.van1);
    const toVan2 = await send(f, 2, admin, f.van1, f.van2);

    // Each salesman sees only transfers touching their van.
    expect((await transfers.findAll({}, ali)).items).toHaveLength(3);
    expect((await transfers.findAll({}, omar)).items).toHaveLength(1);
    await expect(transfers.findById(fromOffice.id, omar)).rejects.toThrow(/not found/);
    await expect(transfers.receive(fromOffice.id, {}, omar)).rejects.toThrow(/not found/);

    // Badge: Ali can receive only the one into his van (not the one he sent, not the one into van 2).
    expect(await transfers.toReceiveCount(ali)).toEqual({ count: 1 });
    expect(await transfers.toReceiveCount(admin)).toEqual({ count: 3 });
    expect((await transfers.findAll({ receivableByMe: true }, ali)).items).toHaveLength(1);
    expect((await transfers.findAll({ receivableByMe: true }, admin)).items).toHaveLength(3);
    await expect(transfers.receive(toOffice.id, {}, ali)).rejects.toThrow(/you sent/);
    await expect(transfers.receive(toVan2.id, {}, ali)).rejects.toThrow(/may not receive stock into/);
    await transfers.receive(fromOffice.id, {}, ali);
    await transfers.receive(toVan2.id, {}, omar);
    expect(await qtyOf(f.dates._id, f.van1._id)).toBe(20);
    expect(await qtyOf(f.dates._id, f.van2._id)).toBe(2);
    await expectBalancesMatchEntries();
  });

  it('filters the list and records audit entries', async () => {
    const f = await fixtures();
    await move(f.dates._id, f.wh._id, 100);
    const first = await send(f, 10);
    await transfers.receive(first.id, {}, admin);
    await send(f, 5, admin, f.wh, f.van2);

    const ids = async (query: object) => (await transfers.findAll(query, admin)).items.map((item) => item.voucherNo);
    expect(await ids({ status: 'in_transit' })).toEqual(['TR-0002']);
    expect(await ids({ toLocationId: f.van1._id.toString() })).toEqual(['TR-0001']);
    expect(await ids({ productId: f.box._id.toString() })).toEqual([]);
    expect(await ids({ q: 'PRD-0001' })).toEqual(['TR-0002', 'TR-0001']);
    expect(await ids({ dateFrom: '2026-02-03' })).toEqual([]);
    expect(await model(AuditLog.name).countDocuments({ entityType: 'stock-transfer', action: 'received' })).toBe(1);
    expect(await model(AuditLog.name).countDocuments({ entityType: 'stock-transfer', action: 'created' })).toBe(2);
  });
});
