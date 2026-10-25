import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Types, type Connection, type Model } from 'mongoose';
import request from 'supertest';
import { mongooseTestRoot } from '../../../../test/mongo-test-db.js';
import { PurchaseInvoiceService } from './purchase-invoice.service.js';
import { PurchaseInvoiceController } from './purchase-invoice.controller.js';
import { PURCHASE_INVOICE_ENTITY_TYPE, PurchaseInvoice, PurchaseInvoiceSchema } from './schemas/purchase-invoice.schema.js';
import { SalesInvoice, SalesInvoiceSchema } from '../../sales/sales-invoices/schemas/sales-invoice.schema.js';
import { StockService } from '../../stock/stock.service.js';
import { StockEntry, StockEntrySchema } from '../../stock/schemas/stock-entry.schema.js';
import { StockBalance, StockBalanceSchema } from '../../stock/schemas/stock-balance.schema.js';
import { Product, ProductSchema, ProductType } from '../../product/products/schemas/product.schema.js';
import { ProductService } from '../../product/products/product.service.js';
import { ProductUsageRegistry } from '../../product/products/product-usage.registry.js';
import { ProductGroup, ProductGroupSchema } from '../../product/product-groups/schemas/product-group.schema.js';
import { Unit, UnitSchema } from '../../product/units/schemas/unit.schema.js';
import { Party, PartySchema, PartyKind, PartyStatus } from '../../party/schemas/party.schema.js';
import { Location, LocationSchema, LocationType, LocationStatus } from '../../location/schemas/location.schema.js';
import { LocationService } from '../../location/location.service.js';
import { VoucherPostingService } from '../../accounting/vouchers/voucher-posting.service.js';
import { LedgerEntry, LedgerEntrySchema } from '../../accounting/vouchers/schemas/ledger-entry.schema.js';
import { LedgerAccountService } from '../../accounting/ledger-accounts/ledger-account.service.js';
import { LedgerAccountUsageRegistry } from '../../accounting/ledger-accounts/ledger-account-usage.registry.js';
import {
  LedgerAccount,
  LedgerAccountSchema,
  LedgerAccountType,
  SYSTEM_ACCOUNTS,
} from '../../accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { AllocationService } from '../../accounting/allocations/allocation.service.js';
import { Allocation, AllocationSchema } from '../../accounting/allocations/schemas/allocation.schema.js';
import {
  OpeningBalance,
  OpeningBalanceSchema,
} from '../../accounting/opening-balances/schemas/opening-balance.schema.js';
import { CompanyService } from '../../company/company.service.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { Counter, CounterSchema } from '../../sequence/schemas/counter.schema.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditLog, AuditLogSchema } from '../../audit/schemas/audit-log.schema.js';
import { CommentsService } from '../../comments/comments.service.js';
import { EntityAccessRegistry } from '../../comments/entity-access.registry.js';
import { Comment, CommentSchema } from '../../comments/schemas/comment.schema.js';
import { UsersService } from '../../users/users.service.js';
import { UserUsageRegistry } from '../../users/user-usage.registry.js';
import { User, UserSchema } from '../../users/schemas/user.schema.js';
import { Role, RoleSchema } from '../../roles/schemas/role.schema.js';
import { FilesService } from '../../files/files.service.js';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { createAppValidationPipe } from '../../../common/pipes/app-validation.pipe.js';
import { configureHttpApp } from '../../../common/http/configure-http-app.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';
import { ADMIN_PERMISSIONS, VAN_SALESMAN_PERMISSIONS } from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';

const user = (name: string, permissions: string[] = [...ADMIN_PERMISSIONS]): AuthenticatedUser => ({
  id: new Types.ObjectId().toString(),
  email: `${name.toLowerCase()}@example.com`,
  name,
  role: { id: new Types.ObjectId().toString(), name: 'r' },
  permissions,
});

type Ref = { _id: Types.ObjectId };

describe('Purchase invoices', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let invoices: PurchaseInvoiceService;
  let stock: StockService;
  const admin = user('Admin');
  let tokenUser: AuthenticatedUser = admin;
  const model = <T>(name: string) => moduleRef.get<Model<T>>(getModelToken(name));
  const models = [
    PurchaseInvoice,
    StockEntry,
    StockBalance,
    Product,
    ProductGroup,
    Unit,
    Party,
    Location,
    LedgerEntry,
    LedgerAccount,
    Counter,
    AuditLog,
    Comment,
  ];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('purchase-invoices'),
        MongooseModule.forFeature([
          { name: PurchaseInvoice.name, schema: PurchaseInvoiceSchema },
          { name: SalesInvoice.name, schema: SalesInvoiceSchema },
          { name: StockEntry.name, schema: StockEntrySchema },
          { name: StockBalance.name, schema: StockBalanceSchema },
          { name: Product.name, schema: ProductSchema },
          { name: ProductGroup.name, schema: ProductGroupSchema },
          { name: Unit.name, schema: UnitSchema },
          { name: Party.name, schema: PartySchema },
          { name: Location.name, schema: LocationSchema },
          { name: LedgerEntry.name, schema: LedgerEntrySchema },
          { name: LedgerAccount.name, schema: LedgerAccountSchema },
          { name: Counter.name, schema: CounterSchema },
          { name: AuditLog.name, schema: AuditLogSchema },
          { name: Comment.name, schema: CommentSchema },
          { name: User.name, schema: UserSchema },
          { name: Role.name, schema: RoleSchema },
          { name: Allocation.name, schema: AllocationSchema },
          { name: OpeningBalance.name, schema: OpeningBalanceSchema },
        ]),
      ],
      controllers: [PurchaseInvoiceController],
      providers: [
        PurchaseInvoiceService,
        AllocationService,
        StockService,
        ProductService,
        ProductUsageRegistry,
        VoucherPostingService,
        LedgerAccountService,
        LedgerAccountUsageRegistry,
        LocationService,
        SequenceService,
        AuditService,
        CommentsService,
        EntityAccessRegistry,
        UsersService,
        UserUsageRegistry,
        {
          provide: CompanyService,
          useValue: {
            ensure: async () => ({ allowNegativeStock: false }),
            getForPrinting: async () => ({ settings: { legalName: 'ALA DATES LLC', currencyCode: 'AED' }, logoDataUrl: null }),
          },
        },
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
    invoices = moduleRef.get(PurchaseInvoiceService);
    stock = moduleRef.get(StockService);
    await Promise.all(models.map((m) => model(m.name).init()));
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  afterEach(async () => {
    tokenUser = admin;
    await Promise.all(models.map((m) => model(m.name).collection.deleteMany({})));
  });

  async function fixtures() {
    const group = await model(ProductGroup.name).create({ code: 'PG-0001', name: 'Dates' });
    const unit = await model(Unit.name).create({ name: 'Kilogram', symbol: 'kg' });
    const product = async (code: string, type: ProductType, vatRate = 5) =>
      (await model(Product.name).create({
        code,
        name: `${code} name`,
        productGroupId: group._id,
        unitId: unit._id,
        type,
        purchasePrice: 1,
        vatRate,
      })) as unknown as Ref & { code: string };
    const account = await model(LedgerAccount.name).create({ code: 'SUP-0001', name: 'Farm', type: LedgerAccountType.SUPPLIER });
    const supplier = (await model(Party.name).create({
      code: 'SUP-0001',
      kind: PartyKind.SUPPLIER,
      name: 'Farm',
      status: PartyStatus.ACTIVE,
      creditDays: 30,
      ledgerAccountId: account._id,
    })) as unknown as Ref;
    const wh = (await model(Location.name).create({
      code: 'WH-0001',
      name: 'Main WH',
      type: LocationType.WAREHOUSE,
      status: LocationStatus.ACTIVE,
    })) as unknown as Ref;
    return {
      supplier,
      supplierAccount: account as unknown as Ref,
      wh,
      ajwa: await product('PRD-0001', ProductType.STOCK),
      freight: await product('PRD-0002', ProductType.NON_STOCK, 0),
    };
  }

  type Fixtures = Awaited<ReturnType<typeof fixtures>>;

  // 10 x 12.5 - 5 = 120 (+6 VAT); freight 30 (0% VAT). Net before VAT 150, tax 6, total 156.
  const input = (f: Fixtures, extra: Record<string, unknown> = {}) => ({
    date: '2026-03-01',
    supplierId: f.supplier._id.toString(),
    locationId: f.wh._id.toString(),
    billNo: 'INV-77',
    lines: [
      { productId: f.ajwa._id.toString(), qty: 10, rate: 12.5, discount: 5 },
      { productId: f.freight._id.toString(), qty: 1, rate: 30 },
    ],
    ...extra,
  });

  const balanceOf = async (id: Types.ObjectId) =>
    ((await model<{ balance: number }>(LedgerAccount.name).findById(id).lean().exec())?.balance ?? 0);
  const systemAccount = async (key: string) =>
    (await model<Ref>(LedgerAccount.name).findOne({ systemKey: key }).lean().exec())!._id;
  const qtyOf = async (productId: Types.ObjectId, locationId: Types.ObjectId) =>
    ((await model<{ qty: number }>(StockBalance.name).findOne({ productId, locationId }).lean().exec())?.qty ?? 0);

  /** A sale-like movement out of stock. */
  const issue = (productId: Types.ObjectId, locationId: Types.ObjectId, qty: number) =>
    runInTransaction(moduleRef.get<Connection>(getConnectionToken()), (session) =>
      stock.post(
        [{ productId, locationId, qty: -qty, date: new Date('2026-03-02'), voucherType: 'test-issue', voucherId: new Types.ObjectId(), voucherNo: 'T-1' }],
        admin,
        session,
      ),
    );

  /** Every ledger balance equals the sum of its entries. */
  async function expectBalancesMatchEntries() {
    const sums = await model(LedgerEntry.name)
      .aggregate<{ _id: Types.ObjectId; net: number }>([
        { $group: { _id: '$accountId', net: { $sum: { $subtract: ['$debit', '$credit'] } } } },
      ])
      .exec();
    const accounts = await model<Ref & { balance: number }>(LedgerAccount.name).find().lean().exec();
    for (const account of accounts) {
      const sum = sums.find((row) => row._id.equals(account._id))?.net ?? 0;
      expect(Math.round(account.balance * 100)).toBe(Math.round(sum * 100));
    }
  }

  it('posts Dr Purchases, Dr VAT Input, Cr supplier and stock-in at the net rate', async () => {
    const f = await fixtures();
    const invoice = await invoices.create(input(f), admin);

    expect(invoice.voucherNo).toBe('PI-0001');
    expect(invoice).toMatchObject({ grossTotal: 155, totalDiscount: 5, taxableTotal: 150, totalTax: 6, netTotal: 156 });
    expect(invoice.dueDate.toISOString().slice(0, 10)).toBe('2026-03-31');
    expect(await balanceOf(await systemAccount(SYSTEM_ACCOUNTS.PURCHASES.key))).toBe(150);
    expect(await balanceOf(await systemAccount(SYSTEM_ACCOUNTS.VAT_INPUT.key))).toBe(6);
    expect(await balanceOf(f.supplierAccount._id)).toBe(-156);
    expect(await model(LedgerEntry.name).countDocuments({ voucherId: invoice._id })).toBe(3);

    // Only the stock line moves stock, at (120 / 10) per unit.
    const entries = await model<{ productId: Types.ObjectId; qty: number; unitCost: number }>(StockEntry.name)
      .find({ voucherType: PURCHASE_INVOICE_ENTITY_TYPE })
      .lean()
      .exec();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ qty: 10, unitCost: 12 });
    expect(await qtyOf(f.ajwa._id, f.wh._id)).toBe(10);

    // Purchase price follows the line rate, audited on the product.
    expect((await model<{ purchasePrice: number }>(Product.name).findById(f.ajwa._id).lean().exec())!.purchasePrice).toBe(12.5);
    expect(await model(AuditLog.name).countDocuments({ entityType: 'product', entityId: f.ajwa._id })).toBe(1);
    await expectBalancesMatchEntries();
  });

  it('refuses a duplicate bill number for the same supplier until the first is cancelled', async () => {
    const f = await fixtures();
    const first = await invoices.create(input(f), admin);
    await expect(invoices.create(input(f, { billNo: ' inv-77 ' }), admin)).rejects.toThrow(/already entered on PI-0001/);

    await invoices.cancel(first._id.toString(), { reason: 'Entered twice' }, admin);
    await expect(invoices.create(input(f), admin)).resolves.toBeDefined();
  });

  it('edit reverses and reposts; blocked when the stock was used; a no-change edit is rejected', async () => {
    const f = await fixtures();
    const invoice = await invoices.create(input(f), admin);
    const id = invoice._id.toString();

    await expect(invoices.update(id, { billNo: 'INV-77' }, admin)).rejects.toThrow('No changes to save');

    const edited = await invoices.update(
      id,
      { lines: [{ productId: f.ajwa._id.toString(), qty: 20, rate: 10 }], changeNote: 'Corrected qty' },
      admin,
    );
    expect(edited).toMatchObject({ taxableTotal: 200, totalTax: 10, netTotal: 210 });
    expect(await balanceOf(f.supplierAccount._id)).toBe(-210);
    expect(await balanceOf(await systemAccount(SYSTEM_ACCOUNTS.PURCHASES.key))).toBe(200);
    expect(await qtyOf(f.ajwa._id, f.wh._id)).toBe(20);
    const audit = await model<{ changes: { field: string }[] }>(AuditLog.name)
      .findOne({ entityType: PURCHASE_INVOICE_ENTITY_TYPE, action: 'updated' })
      .lean()
      .exec();
    expect(audit!.changes.map((change) => change.field)).toEqual(expect.arrayContaining(['netTotal', 'lines']));

    await issue(f.ajwa._id, f.wh._id, 15);
    await expect(
      invoices.update(id, { lines: [{ productId: f.ajwa._id.toString(), qty: 2, rate: 10 }] }, admin),
    ).rejects.toThrow(/Not enough stock/);
    expect(await balanceOf(f.supplierAccount._id)).toBe(-210);
    await expectBalancesMatchEntries();
  });

  it('cancel restores ledger and stock; refused when the stock was used', async () => {
    const f = await fixtures();
    const used = await invoices.create(input(f), admin);
    await issue(f.ajwa._id, f.wh._id, 4);
    await expect(invoices.cancel(used._id.toString(), { reason: 'Wrong supplier' }, admin)).rejects.toThrow(/Not enough stock/);

    const other = await invoices.create(input(f, { billNo: 'INV-78' }), admin);
    await invoices.cancel(other._id.toString(), { reason: 'Wrong supplier' }, admin);
    expect(await balanceOf(f.supplierAccount._id)).toBe(-156);
    expect(await qtyOf(f.ajwa._id, f.wh._id)).toBe(6);
    await expect(invoices.update(other._id.toString(), { billNo: 'X' }, admin)).rejects.toThrow(/cancelled/);
    await expectBalancesMatchEntries();
  });

  it('marks products and the supplier account as used', async () => {
    const f = await fixtures();
    await invoices.create(input(f, { updatePurchasePrice: false }), admin);
    expect(await moduleRef.get(ProductUsageRegistry).isProductUsed(f.ajwa._id)).toBe(true);
    expect(await moduleRef.get(LedgerAccountService).isLedgerAccountUsed(f.supplierAccount._id.toString())).toBe(true);
    expect((await model<{ purchasePrice: number }>(Product.name).findById(f.ajwa._id).lean().exec())!.purchasePrice).toBe(1);
    // System accounts can't be picked as a header/expense account.
    await expect(
      moduleRef
        .get(LedgerAccountService)
        .findActiveReceiptAccount((await systemAccount(SYSTEM_ACCOUNTS.PURCHASES.key)).toString(), [LedgerAccountType.EXPENSE]),
    ).rejects.toThrow(/system account/);
  });

  it('HTTP: lists with summary, prints a PDF, and refuses a van salesman', async () => {
    const f = await fixtures();
    await invoices.create(input(f), admin);
    const cancelled = await invoices.create(input(f, { billNo: 'INV-80' }), admin);
    await invoices.cancel(cancelled._id.toString(), { reason: 'Duplicate bill' }, admin);

    const list = await request(app.getHttpServer()).get('/purchase-invoices').query({ q: 'inv-7' }).expect(200);
    expect(list.body.summary).toEqual({ count: 1, netTotal: 156, outstanding: 156 });
    const all = await request(app.getHttpServer()).get('/purchase-invoices').expect(200);
    expect(all.body.summary).toEqual({ count: 2, netTotal: 156, outstanding: 156 });
    const unpaid = await request(app.getHttpServer()).get('/purchase-invoices').query({ paymentStatus: 'unpaid' }).expect(200);
    expect(unpaid.body.summary.count).toBe(1);

    const pdf = await request(app.getHttpServer()).get(`/purchase-invoices/${cancelled._id.toString()}/pdf`).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');

    await request(app.getHttpServer())
      .post(`/purchase-invoices/${cancelled._id.toString()}/cancel`)
      .send({})
      .expect(400);

    tokenUser = user('Van', [...VAN_SALESMAN_PERMISSIONS]);
    await request(app.getHttpServer()).get('/purchase-invoices').expect(403);
  });
});
