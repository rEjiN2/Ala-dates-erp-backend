import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Types, type Connection, type Model } from 'mongoose';
import request from 'supertest';
import { mongooseTestRoot } from '../../../../test/mongo-test-db.js';
import { SalesInvoiceService } from './sales-invoice.service.js';
import { SalesInvoiceController } from './sales-invoice.controller.js';
import { SalesInvoice, SalesInvoiceSchema } from './schemas/sales-invoice.schema.js';
import { PurchaseInvoice, PurchaseInvoiceSchema } from '../../purchase/purchase-invoices/schemas/purchase-invoice.schema.js';
import { StockService } from '../../stock/stock.service.js';
import { StockEntry, StockEntrySchema } from '../../stock/schemas/stock-entry.schema.js';
import { StockBalance, StockBalanceSchema } from '../../stock/schemas/stock-balance.schema.js';
import { Product, ProductSchema, ProductType } from '../../product/products/schemas/product.schema.js';
import { ProductService } from '../../product/products/product.service.js';
import { ProductUsageRegistry } from '../../product/products/product-usage.registry.js';
import { ProductGroup, ProductGroupSchema } from '../../product/product-groups/schemas/product-group.schema.js';
import { Unit, UnitSchema } from '../../product/units/schemas/unit.schema.js';
import { CASH_CUSTOMER_KEY, Party, PartySchema, PartyKind, PartyStatus } from '../../party/schemas/party.schema.js';
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
import { CashReceiptService } from '../../accounting/cash-receipts/cash-receipt.service.js';
import { CashReceipt, CashReceiptSchema } from '../../accounting/cash-receipts/schemas/cash-receipt.schema.js';
import { ChequeStatus, VoucherStatus } from '../../accounting/vouchers/schemas/voucher.schema.js';
import { AllocationService } from '../../accounting/allocations/allocation.service.js';
import { Allocation, AllocationSchema, PaymentStatus } from '../../accounting/allocations/schemas/allocation.schema.js';
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
import { ADMIN_PERMISSIONS, DataScope, Permission, VAN_SALESMAN_PERMISSIONS } from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';

type Ref = { _id: Types.ObjectId };

describe('Sales invoices', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let invoices: SalesInvoiceService;
  let stock: StockService;
  const admin: AuthenticatedUser = {
    id: new Types.ObjectId().toString(),
    email: 'admin@example.com',
    name: 'Admin',
    role: { id: new Types.ObjectId().toString(), name: 'admin' },
    permissions: [...ADMIN_PERMISSIONS],
  };
  let tokenUser: AuthenticatedUser = admin;
  const model = <T>(name: string) => moduleRef.get<Model<T>>(getModelToken(name));
  const models = [
    SalesInvoice,
    CashReceipt,
    Allocation,
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
    User,
    Role,
  ];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('sales-invoices'),
        MongooseModule.forFeature([
          { name: SalesInvoice.name, schema: SalesInvoiceSchema },
          { name: PurchaseInvoice.name, schema: PurchaseInvoiceSchema },
          { name: CashReceipt.name, schema: CashReceiptSchema },
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
      controllers: [SalesInvoiceController],
      providers: [
        SalesInvoiceService,
        CashReceiptService,
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
            ensure: async () => ({ allowNegativeStock: false, defaultChequesInHandAccountId: null }),
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
    invoices = moduleRef.get(SalesInvoiceService);
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

  /** Saves the user with a role holding its permissions, so it can sell and collect. */
  async function persist(user: AuthenticatedUser) {
    const role = await model(Role.name).create({
      name: `${user.name} role`,
      permissions: user.permissions,
      dataScope: user.dataScope ?? DataScope.ALL,
    });
    await model(User.name).create({
      _id: new Types.ObjectId(user.id),
      email: user.email,
      name: user.name,
      passwordHash: 'x',
      role: role._id,
    });
    return user;
  }

  async function fixtures() {
    await persist(admin);
    const group = await model(ProductGroup.name).create({ code: 'PG-0001', name: 'Dates' });
    const unit = await model(Unit.name).create({ name: 'Kilogram', symbol: 'kg' });
    const product = async (code: string, type: ProductType, salePrice: number, vatRate = 5) =>
      (await model(Product.name).create({
        code,
        name: `${code} name`,
        productGroupId: group._id,
        unitId: unit._id,
        type,
        salePrice,
        purchasePrice: 6,
        vatRate,
      })) as unknown as Ref;
    const customer = async (code: string, name: string, extra: Record<string, unknown> = {}) => {
      const account = await model(LedgerAccount.name).create({ code, name, type: LedgerAccountType.PARTY });
      const party = (await model(Party.name).create({
        code,
        kind: PartyKind.CUSTOMER,
        name,
        status: PartyStatus.ACTIVE,
        creditDays: 15,
        ledgerAccountId: account._id,
        ...extra,
      })) as unknown as Ref;
      return { party, account: account as unknown as Ref };
    };
    const van = (await model(Location.name).create({
      code: 'VAN-0001',
      name: 'Van 1',
      type: LocationType.VAN,
      status: LocationStatus.ACTIVE,
    })) as unknown as Ref;
    const cash = (await model(LedgerAccount.name).create({
      code: 'CASH-0009',
      name: 'Salesman Cash',
      type: LedgerAccountType.CASH,
    })) as unknown as Ref;
    const salesman = await persist({
      id: new Types.ObjectId().toString(),
      email: 'sam@example.com',
      name: 'Sam',
      role: { id: new Types.ObjectId().toString(), name: 'Van Salesman' },
      permissions: [...VAN_SALESMAN_PERMISSIONS],
      dataScope: DataScope.OWN,
      allowedLocationIds: [van._id.toString()],
      allowedCashAccountIds: [cash._id.toString()],
    });
    const ajwa = await product('PRD-0001', ProductType.STOCK, 20);
    const f = {
      shop: await customer('CUS-0001', 'Corner Shop'),
      walkIn: await customer('CUS-0002', 'Cash Customer', { systemKey: CASH_CUSTOMER_KEY }),
      van,
      cash,
      salesman,
      ajwa,
      delivery: await product('PRD-0002', ProductType.NON_STOCK, 10, 0),
    };
    // 50 in the van.
    await runInTransaction(moduleRef.get<Connection>(getConnectionToken()), (session) =>
      stock.post(
        [{ productId: ajwa._id, locationId: van._id, qty: 50, date: new Date('2026-03-01'), voucherType: 'test-in', voucherId: new Types.ObjectId(), voucherNo: 'T-1' }],
        admin,
        session,
      ),
    );
    return f;
  }

  type Fixtures = Awaited<ReturnType<typeof fixtures>>;

  // 10 x 20 = 200 (+10 VAT); delivery 10 (0% VAT). Net before VAT 210, tax 10, total 220.
  const input = (f: Fixtures, extra: Record<string, unknown> = {}) => ({
    date: '2026-03-05',
    customerId: f.shop.party._id.toString(),
    locationId: f.van._id.toString(),
    lines: [
      { productId: f.ajwa._id.toString(), qty: 10 },
      { productId: f.delivery._id.toString(), qty: 1 },
    ],
    ...extra,
  });

  const balanceOf = async (id: Types.ObjectId) =>
    ((await model<{ balance: number }>(LedgerAccount.name).findById(id).lean().exec())?.balance ?? 0);
  const systemAccount = async (key: string) =>
    (await model<Ref>(LedgerAccount.name).findOne({ systemKey: key }).lean().exec())!._id;
  const qtyOf = async (productId: Types.ObjectId, locationId: Types.ObjectId) =>
    ((await model<{ qty: number }>(StockBalance.name).findOne({ productId, locationId }).lean().exec())?.qty ?? 0);

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

  it('a van sale takes stock out of the van and makes the customer owe the total', async () => {
    const f = await fixtures();
    // The salesman's only location is the default.
    const invoice = await invoices.create(input(f, { locationId: undefined }), f.salesman);

    expect(invoice.voucherNo).toBe('SI-0001');
    expect(invoice).toMatchObject({ taxableTotal: 210, totalTax: 10, netTotal: 220, balance: 220, paymentStatus: PaymentStatus.UNPAID });
    expect(invoice.locationId.toString()).toBe(f.van._id.toString());
    expect(invoice.soldById.toString()).toBe(f.salesman.id);
    expect(invoice.dueDate.toISOString().slice(0, 10)).toBe('2026-03-20');
    expect(invoice.lines[0].unitCost).toBe(6);
    expect(await qtyOf(f.ajwa._id, f.van._id)).toBe(40);
    expect(await balanceOf(f.shop.account._id)).toBe(220);
    expect(await balanceOf(await systemAccount(SYSTEM_ACCOUNTS.SALES.key))).toBe(-210);
    expect(await balanceOf(await systemAccount(SYSTEM_ACCOUNTS.VAT_OUTPUT.key))).toBe(-10);
    await expectBalancesMatchEntries();
  });

  it('pay-now cash lands in the salesman cash account and shows Paid', async () => {
    const f = await fixtures();
    const invoice = await invoices.create(
      input(f, { payNow: { method: 'cash', accountId: f.cash._id.toString(), amount: 220 } }),
      f.salesman,
    );

    expect(invoice).toMatchObject({ paidAmount: 220, balance: 0, paymentStatus: PaymentStatus.PAID });
    const receipt = await model<{ voucherNo: string; collectedById: Types.ObjectId }>(CashReceipt.name)
      .findById(invoice.paymentReceiptId)
      .lean()
      .exec();
    expect(receipt!.collectedById.toString()).toBe(f.salesman.id);
    expect(await balanceOf(f.cash._id)).toBe(220);
    expect(await balanceOf(f.shop.account._id)).toBe(0);
    await expectBalancesMatchEntries();
  });

  it('blocks selling more than the van holds', async () => {
    const f = await fixtures();
    await expect(
      invoices.create(input(f, { lines: [{ productId: f.ajwa._id.toString(), qty: 51 }] }), f.salesman),
    ).rejects.toThrow(/Not enough stock/);
    expect(await qtyOf(f.ajwa._id, f.van._id)).toBe(50);
    expect(await model(SalesInvoice.name).countDocuments()).toBe(0);
  });

  it("a salesman can't change the price or give a discount, and gets no cost back", async () => {
    const f = await fixtures();
    tokenUser = f.salesman;
    const post = (lines: Record<string, unknown>[]) =>
      request(app.getHttpServer()).post('/sales-invoices').send({ ...input(f), lines });

    await post([{ productId: f.ajwa._id.toString(), qty: 1, rate: 15 }]).expect(403);
    await post([{ productId: f.ajwa._id.toString(), qty: 1, discount: 2 }]).expect(403);
    const ok = await post([{ productId: f.ajwa._id.toString(), qty: 1, rate: 20 }]).expect(201);
    expect(ok.body.lines[0].unitCost).toBeUndefined();
    tokenUser = admin;
    const other = await post([{ productId: f.ajwa._id.toString(), qty: 1, rate: 15, discount: 2 }]).expect(201);
    expect(other.body).toMatchObject({ netTotal: 13.65 });
    expect(other.body.lines[0].unitCost).toBe(6);
  });

  it('cancel restores stock, ledger and the pay-at-sale receipt', async () => {
    const f = await fixtures();
    const invoice = await invoices.create(
      input(f, { payNow: { method: 'cash', accountId: f.cash._id.toString(), amount: 100 } }),
      f.salesman,
    );
    expect(invoice).toMatchObject({ paidAmount: 100, balance: 120, paymentStatus: PaymentStatus.PARTLY_PAID });

    await expect(invoices.update(invoice._id.toString(), { remarks: 'x' }, admin)).rejects.toThrow(/payments allocated/);
    const cancelled = await invoices.cancel(invoice._id.toString(), { reason: 'Wrong customer' }, admin);

    expect(cancelled.status).toBe(VoucherStatus.CANCELLED);
    expect(await qtyOf(f.ajwa._id, f.van._id)).toBe(50);
    expect(await balanceOf(f.shop.account._id)).toBe(0);
    expect(await balanceOf(f.cash._id)).toBe(0);
    expect(await balanceOf(await systemAccount(SYSTEM_ACCOUNTS.SALES.key))).toBe(0);
    const receipt = await model<{ status: string }>(CashReceipt.name).findById(invoice.paymentReceiptId).lean().exec();
    expect(receipt!.status).toBe(VoucherStatus.CANCELLED);
    await expectBalancesMatchEntries();
  });

  it('cancel is blocked while the pay-at-sale cheque is deposited', async () => {
    const f = await fixtures();
    const cheques = (await model(LedgerAccount.name).create({
      code: 'CHQ-0001',
      name: 'Cheques in Hand',
      type: LedgerAccountType.CHEQUE,
    })) as unknown as Ref;
    const invoice = await invoices.create(
      input(f, {
        payNow: {
          method: 'cheque',
          accountId: cheques._id.toString(),
          amount: 220,
          chequeNumber: '000123',
          chequeDate: '2026-03-10',
          chequeBankName: 'ENBD',
        },
      }),
      admin,
    );
    await model(CashReceipt.name).updateOne({ _id: invoice.paymentReceiptId }, { chequeStatus: ChequeStatus.DEPOSITED });

    await expect(invoices.cancel(invoice._id.toString(), { reason: 'Returned goods' }, admin)).rejects.toThrow(
      /can't be cancelled because its payment CR/,
    );
    expect(await qtyOf(f.ajwa._id, f.van._id)).toBe(40);
  });

  it('enforces the credit limit unless overridden and acknowledged', async () => {
    const f = await fixtures();
    await model(Party.name).updateOne({ _id: f.shop.party._id }, { creditLimit: 200 });
    const noOverride = { ...admin, permissions: admin.permissions.filter((p) => p !== Permission.SALES_OVERRIDE_CREDIT) };

    await expect(invoices.create(input(f), noOverride)).rejects.toThrow(/over the credit limit.*override-credit/);
    await expect(invoices.create(input(f), admin)).rejects.toThrow(/acknowledgeCredit/);
    // Paying part now keeps the customer within the limit.
    await invoices.create(input(f, { payNow: { method: 'cash', accountId: f.cash._id.toString(), amount: 20 } }), admin);
    await invoices.create(input(f, { acknowledgeCredit: true }), admin);
    expect(await balanceOf(f.shop.account._id)).toBe(420);
    await expectBalancesMatchEntries();
  });

  it('Cash Customer must pay the full total at sale', async () => {
    const f = await fixtures();
    const walkIn = { customerId: f.walkIn.party._id.toString() };

    await expect(invoices.create(input(f, walkIn), admin)).rejects.toThrow(/can't buy on credit/);
    await expect(
      invoices.create(input(f, { ...walkIn, payNow: { method: 'cash', accountId: f.cash._id.toString(), amount: 200 } }), admin),
    ).rejects.toThrow(/can't buy on credit/);
    const paid = await invoices.create(
      input(f, { ...walkIn, payNow: { method: 'cash', accountId: f.cash._id.toString(), amount: 220 } }),
      admin,
    );
    expect(paid.paymentStatus).toBe(PaymentStatus.PAID);
  });

  it('edits an unpaid invoice by reverse + repost and scopes the list to the salesman', async () => {
    const f = await fixtures();
    const invoice = await invoices.create(input(f), f.salesman);
    await invoices.create(input(f), admin);

    const edited = await invoices.update(
      invoice._id.toString(),
      { lines: [{ productId: f.ajwa._id.toString(), qty: 5 }] },
      admin,
    );
    expect(edited).toMatchObject({ netTotal: 105, balance: 105 });
    expect(await qtyOf(f.ajwa._id, f.van._id)).toBe(35);
    expect(await balanceOf(f.shop.account._id)).toBe(325);
    await expectBalancesMatchEntries();

    const mine = await invoices.findAll({}, f.salesman);
    expect(mine.items.map((item) => item.voucherNo)).toEqual(['SI-0001']);
    expect(mine.summary).toMatchObject({ count: 1, netTotal: 105, outstanding: 105 });
  });
});
