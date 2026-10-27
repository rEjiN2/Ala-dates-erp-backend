import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Types, type Connection, type Model } from 'mongoose';
import request from 'supertest';
import { mongooseTestRoot } from '../../../../test/mongo-test-db.js';
import { ReturnService } from './return.service.js';
import { SalesReturnService } from './sales-return.service.js';
import { PurchaseReturnService } from './purchase-return.service.js';
import { SalesReturnController } from './sales-return.controller.js';
import { PurchaseReturnController } from './purchase-return.controller.js';
import {
  PurchaseReturn,
  PurchaseReturnSchema,
  PURCHASE_RETURN_ENTITY_TYPE,
  SALES_RETURN_ENTITY_TYPE,
  SalesReturn,
  SalesReturnSchema,
} from './schemas/return.schema.js';
import { SalesInvoiceService } from '../../sales/sales-invoices/sales-invoice.service.js';
import { SalesInvoice, SalesInvoiceSchema } from '../../sales/sales-invoices/schemas/sales-invoice.schema.js';
import { PurchaseInvoiceService } from '../../purchase/purchase-invoices/purchase-invoice.service.js';
import { PurchaseInvoice, PurchaseInvoiceSchema } from '../../purchase/purchase-invoices/schemas/purchase-invoice.schema.js';
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
import { VoucherPostingService } from '../vouchers/voucher-posting.service.js';
import { LedgerEntry, LedgerEntrySchema } from '../vouchers/schemas/ledger-entry.schema.js';
import { LedgerAccountService } from '../ledger-accounts/ledger-account.service.js';
import { LedgerAccountUsageRegistry } from '../ledger-accounts/ledger-account-usage.registry.js';
import {
  LedgerAccount,
  LedgerAccountSchema,
  LedgerAccountType,
  SYSTEM_ACCOUNTS,
} from '../ledger-accounts/schemas/ledger-account.schema.js';
import { CashReceiptService } from '../cash-receipts/cash-receipt.service.js';
import { CashPayment, CashPaymentSchema } from '../cash-payments/schemas/cash-payment.schema.js';
import { CashReceipt, CashReceiptSchema } from '../cash-receipts/schemas/cash-receipt.schema.js';
import { VoucherStatus } from '../vouchers/schemas/voucher.schema.js';
import { AllocationService } from '../allocations/allocation.service.js';
import {
  Allocation,
  AllocationSchema,
  AllocationTargetType,
  PaymentStatus,
} from '../allocations/schemas/allocation.schema.js';
import { OpeningBalance, OpeningBalanceSchema } from '../opening-balances/schemas/opening-balance.schema.js';
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
import {
  ACCOUNTANT_PERMISSIONS,
  ADMIN_PERMISSIONS,
  DataScope,
  Permission,
  VAN_SALESMAN_PERMISSIONS,
} from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';

type Ref = { _id: Types.ObjectId };

describe('Sales and purchase returns', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let salesInvoices: SalesInvoiceService;
  let purchaseInvoices: PurchaseInvoiceService;
  let salesReturns: SalesReturnService;
  let purchaseReturns: PurchaseReturnService;
  let allocations: AllocationService;
  let stock: StockService;
  const company = { allowNegativeStock: false };
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
    PurchaseInvoice,
    SalesReturn,
    PurchaseReturn,
    CashReceipt,
    CashPayment,
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
    OpeningBalance,
  ];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('returns'),
        MongooseModule.forFeature(models.map((m) => ({ name: m.name, schema: SCHEMAS.get(m.name)! }))),
      ],
      controllers: [SalesReturnController, PurchaseReturnController],
      providers: [
        ReturnService,
        SalesReturnService,
        PurchaseReturnService,
        SalesInvoiceService,
        PurchaseInvoiceService,
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
            ensure: async () => ({ allowNegativeStock: company.allowNegativeStock, defaultChequesInHandAccountId: null }),
            getForPrinting: async () => ({
              settings: { legalName: 'ALA DATES LLC', currencyCode: 'AED', trn: '100123456700003' },
              logoDataUrl: null,
            }),
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
    salesInvoices = moduleRef.get(SalesInvoiceService);
    purchaseInvoices = moduleRef.get(PurchaseInvoiceService);
    salesReturns = moduleRef.get(SalesReturnService);
    purchaseReturns = moduleRef.get(PurchaseReturnService);
    allocations = moduleRef.get(AllocationService);
    stock = moduleRef.get(StockService);
    await Promise.all(models.map((m) => model(m.name).init()));
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  afterEach(async () => {
    tokenUser = admin;
    company.allowNegativeStock = false;
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
    const ajwa = (await model(Product.name).create({
      code: 'PRD-0001',
      name: 'Ajwa',
      productGroupId: group._id,
      unitId: unit._id,
      type: ProductType.STOCK,
      salePrice: 20,
      purchasePrice: 6,
      vatRate: 5,
    })) as unknown as Ref;
    const party = async (kind: PartyKind, code: string, name: string, accountType: LedgerAccountType) => {
      const account = await model(LedgerAccount.name).create({ code, name, type: accountType });
      const doc = (await model(Party.name).create({
        code,
        kind,
        name,
        status: PartyStatus.ACTIVE,
        creditDays: 15,
        // Unique per kind among active parties: only the two printed in the PDF test have one.
        vatNumber: code === 'CUS-0001' ? '100999999900003' : code === 'SUP-0001' ? '100888888800003' : null,
        ledgerAccountId: account._id,
      })) as unknown as Ref;
      return { party: doc, account: account as unknown as Ref };
    };
    const location = async (code: string, name: string, type: LocationType) =>
      (await model(Location.name).create({ code, name, type, status: LocationStatus.ACTIVE })) as unknown as Ref;
    const van = await location('VAN-0001', 'Van 1', LocationType.VAN);
    const warehouse = await location('WH-0001', 'Main Warehouse', LocationType.WAREHOUSE);
    const cash = (await model(LedgerAccount.name).create({
      code: 'CASH-0009',
      name: 'Cash',
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
    await postStock(ajwa._id, van._id, 50);
    return {
      ajwa,
      van,
      warehouse,
      cash,
      salesman,
      shop: await party(PartyKind.CUSTOMER, 'CUS-0001', 'Corner Shop', LedgerAccountType.PARTY),
      other: await party(PartyKind.CUSTOMER, 'CUS-0002', 'Other Shop', LedgerAccountType.PARTY),
      farm: await party(PartyKind.SUPPLIER, 'SUP-0001', 'Omar Farms', LedgerAccountType.SUPPLIER),
    };
  }

  type Fixtures = Awaited<ReturnType<typeof fixtures>>;

  const connection = () => moduleRef.get<Connection>(getConnectionToken());

  /** Stock in (+) or out (-) straight through the engine, as another voucher would. */
  const postStock = (productId: Types.ObjectId, locationId: Types.ObjectId, qty: number) =>
    runInTransaction(connection(), (session) =>
      stock.post(
        [
          {
            productId,
            locationId,
            qty,
            date: new Date('2026-03-01'),
            voucherType: 'test',
            voucherId: new Types.ObjectId(),
            voucherNo: 'T-1',
          },
        ],
        admin,
        session,
      ),
    );

  // 10 x 20 = 200 (+10 VAT) = 210.
  const sale = (f: Fixtures, extra: Record<string, unknown> = {}, actor = admin, customer = f.shop) =>
    salesInvoices.create(
      {
        date: '2026-03-05',
        customerId: customer.party._id.toString(),
        locationId: f.van._id.toString(),
        lines: [{ productId: f.ajwa._id.toString(), qty: 10 }],
        ...extra,
      },
      actor,
    );

  // 10 x 6 = 60 (+3 VAT) = 63, into the warehouse.
  const purchase = (f: Fixtures) =>
    purchaseInvoices.create(
      {
        date: '2026-03-02',
        supplierId: f.farm.party._id.toString(),
        locationId: f.warehouse._id.toString(),
        billNo: 'INV-77',
        lines: [{ productId: f.ajwa._id.toString(), qty: 10, rate: 6 }],
      },
      admin,
    );

  type Sold = Awaited<ReturnType<typeof sale>>;
  type Bought = Awaited<ReturnType<typeof purchase>>;

  const giveBack = (invoice: Sold, qty: number, extra: Record<string, unknown> = {}, actor = admin) =>
    salesReturns.create(
      {
        date: '2026-03-10',
        salesInvoiceId: invoice._id.toString(),
        reason: 'Damaged',
        lines: [{ invoiceLineId: invoice.lines[0]._id!.toString(), qty }],
        ...extra,
      },
      actor,
    );

  const sendBack = (invoice: Bought, qty: number) =>
    purchaseReturns.create(
      {
        date: '2026-03-10',
        purchaseInvoiceId: invoice._id.toString(),
        reason: 'Wrong grade',
        lines: [{ invoiceLineId: invoice.lines[0]._id!.toString(), qty }],
      },
      admin,
    );

  const balanceOf = async (id: Types.ObjectId) =>
    ((await model<{ balance: number }>(LedgerAccount.name).findById(id).lean().exec())?.balance ?? 0);
  const systemAccount = async (key: string) =>
    (await model<Ref>(LedgerAccount.name).findOne({ systemKey: key }).lean().exec())!._id;
  const qtyOf = async (productId: Types.ObjectId, locationId: Types.ObjectId) =>
    ((await model<{ qty: number }>(StockBalance.name).findOne({ productId, locationId }).lean().exec())?.qty ?? 0);
  const reload = <T>(name: string, id: Types.ObjectId) => model<T>(name).findById(id).lean().exec() as Promise<T>;

  /** Every ledger balance equals the sum of its entries, and every stock balance the sum of its entries. */
  async function expectBalancesMatchEntries() {
    const sums = await model(LedgerEntry.name)
      .aggregate<{ _id: Types.ObjectId; net: number }>([
        { $group: { _id: '$accountId', net: { $sum: { $subtract: ['$debit', '$credit'] } } } },
      ])
      .exec();
    for (const account of await model<Ref & { balance: number }>(LedgerAccount.name).find().lean().exec()) {
      const sum = sums.find((row) => row._id.equals(account._id))?.net ?? 0;
      expect(Math.round(account.balance * 100)).toBe(Math.round(sum * 100));
    }
    const stockSums = await model(StockEntry.name)
      .aggregate<{ _id: { p: Types.ObjectId; l: Types.ObjectId }; qty: number }>([
        { $group: { _id: { p: '$productId', l: '$locationId' }, qty: { $sum: '$qty' } } },
      ])
      .exec();
    for (const balance of await model<{ productId: Types.ObjectId; locationId: Types.ObjectId; qty: number }>(StockBalance.name)
      .find()
      .lean()
      .exec()) {
      const sum = stockSums.find((row) => row._id.p.equals(balance.productId) && row._id.l.equals(balance.locationId))?.qty ?? 0;
      expect(Math.round(balance.qty * 1000)).toBe(Math.round(sum * 1000));
    }
  }

  it('returning 3 of 10 restocks 3 and cuts the customer balance by the pro-rata total', async () => {
    const f = await fixtures();
    const invoice = await sale(f);
    const credit = await giveBack(invoice, 3);

    expect(credit.voucherNo).toBe('SR-0001');
    expect(credit.lines[0]).toMatchObject({ qty: 3, amount: 60, vat: 3, netAmount: 63, unitCost: 6, restock: true });
    expect(credit).toMatchObject({ taxableTotal: 60, totalTax: 3, netTotal: 63 });
    expect(credit.locationId.toString()).toBe(f.van._id.toString());
    expect(await qtyOf(f.ajwa._id, f.van._id)).toBe(43);
    expect(await balanceOf(f.shop.account._id)).toBe(147);
    expect(await balanceOf(await systemAccount(SYSTEM_ACCOUNTS.SALES_RETURNS.key))).toBe(60);
    expect(await balanceOf(await systemAccount(SYSTEM_ACCOUNTS.VAT_OUTPUT.key))).toBe(-7);

    // The credit is applied to the invoice it came from.
    const after = await reload<Sold>(SalesInvoice.name, invoice._id);
    expect(after).toMatchObject({
      returnedQty: 3,
      returnedAmount: 63,
      creditedAmount: 63,
      paidAmount: 0,
      balance: 147,
      paymentStatus: PaymentStatus.PARTLY_PAID,
    });
    expect(after.lines[0].returnedQty).toBe(3);
    const detail = await salesReturns.detail(credit._id.toString(), admin);
    expect(detail).toMatchObject({ creditApplied: 63, onAccount: 0 });
    expect(detail.allocations).toHaveLength(1);
    await expectBalancesMatchEntries();
  });

  it('refuses over-returning, duplicate lines and cancelled invoices', async () => {
    const f = await fixtures();
    const invoice = await sale(f);
    await giveBack(invoice, 3);

    await expect(giveBack(invoice, 8)).rejects.toThrow(
      'Line 1: PRD-0001 (Ajwa) has 7 left to return (10 on SI-0001, 3 already returned), not 8',
    );
    const lineId = invoice.lines[0]._id!.toString();
    await expect(
      giveBack(invoice, 1, {
        lines: [
          { invoiceLineId: lineId, qty: 1 },
          { invoiceLineId: lineId, qty: 1 },
        ],
      }),
    ).rejects.toThrow('Line 2: that invoice line is already on this sales return');
    await expect(giveBack(invoice, 1, { lines: [{ invoiceLineId: new Types.ObjectId().toString(), qty: 1 }] })).rejects.toThrow(
      /has no line/,
    );
    // 7 is exactly what is left.
    await expect(giveBack(invoice, 7)).resolves.toBeDefined();
    const full = await reload<Sold>(SalesInvoice.name, invoice._id);
    expect(full).toMatchObject({ returnedQty: 10, returnedAmount: 210, balance: 0, paymentStatus: PaymentStatus.PAID });
    expect(await model(SalesReturn.name).countDocuments()).toBe(2);

    const gone = await sale(f);
    await salesInvoices.cancel(gone._id.toString(), { reason: 'Entered twice' }, admin);
    await expect(giveBack(gone, 1)).rejects.toThrow(/cancelled/);
  });

  it('restock=false posts accounts only', async () => {
    const f = await fixtures();
    const invoice = await sale(f);
    const credit = await giveBack(invoice, 2, { lines: [{ invoiceLineId: invoice.lines[0]._id!.toString(), qty: 2, restock: false }] });

    expect(credit.lines[0].restock).toBe(false);
    expect(await qtyOf(f.ajwa._id, f.van._id)).toBe(40);
    expect(await model(StockEntry.name).countDocuments({ voucherType: SALES_RETURN_ENTITY_TYPE })).toBe(0);
    expect(await balanceOf(f.shop.account._id)).toBe(168);
    await expectBalancesMatchEntries();
  });

  it('credit above the invoice balance stays on account and is listed as unallocated', async () => {
    const f = await fixtures();
    // 200 of the 210 paid at the sale: 10 left on the invoice.
    const invoice = await sale(f, { payNow: { method: 'cash', accountId: f.cash._id.toString(), amount: 200 } });
    const credit = await giveBack(invoice, 3);

    const after = await reload<Sold>(SalesInvoice.name, invoice._id);
    expect(after).toMatchObject({ paidAmount: 200, creditedAmount: 10, balance: 0, paymentStatus: PaymentStatus.PAID });
    const detail = await salesReturns.detail(credit._id.toString(), admin);
    expect(detail).toMatchObject({ creditApplied: 10, onAccount: 53 });
    // The customer is owed 53 (63 credit less the 10 that cleared the invoice).
    expect(await balanceOf(f.shop.account._id)).toBe(-53);
    const unallocated = await allocations.unallocatedPayments(f.shop.party._id.toString());
    expect(unallocated).toEqual([
      expect.objectContaining({ paymentVoucherType: SALES_RETURN_ENTITY_TYPE, voucherNo: 'SR-0001', amount: 63, unallocated: 53 }),
    ]);

    // The remainder can be applied to another invoice of the same customer.
    const next = await sale(f);
    await allocations.create(
      {
        paymentVoucherType: SALES_RETURN_ENTITY_TYPE,
        paymentVoucherId: credit._id.toString(),
        paymentLineIndex: 0,
        targetType: AllocationTargetType.SALES_INVOICE,
        targetId: next._id.toString(),
        amount: 53,
      },
      admin,
    );
    expect(await reload<Sold>(SalesInvoice.name, next._id)).toMatchObject({ creditedAmount: 53, balance: 157 });
    expect(await allocations.unallocatedPayments(f.shop.party._id.toString())).toEqual([]);
    await expectBalancesMatchEntries();
  });

  it('a purchase return takes stock out, obeys the negative stock rule and cancels cleanly', async () => {
    const f = await fixtures();
    const bill = await purchase(f);
    expect(await qtyOf(f.ajwa._id, f.warehouse._id)).toBe(10);
    const debit = await sendBack(bill, 4);

    expect(debit.voucherNo).toBe('PR-0001');
    expect(debit).toMatchObject({ taxableTotal: 24, totalTax: 1.2, netTotal: 25.2 });
    expect(await qtyOf(f.ajwa._id, f.warehouse._id)).toBe(6);
    expect(await balanceOf(f.farm.account._id)).toBeCloseTo(-37.8, 2);
    expect(await balanceOf(await systemAccount(SYSTEM_ACCOUNTS.PURCHASE_RETURNS.key))).toBe(-24);
    expect(await balanceOf(await systemAccount(SYSTEM_ACCOUNTS.VAT_INPUT.key))).toBeCloseTo(1.8, 2);
    expect(await reload<Bought>(PurchaseInvoice.name, bill._id)).toMatchObject({
      returnedQty: 4,
      returnedAmount: 25.2,
      creditedAmount: 25.2,
      balance: 37.8,
    });
    await expectBalancesMatchEntries();

    // Use up the stock: another 4 can't go back to the supplier unless negative stock is allowed.
    await postStock(f.ajwa._id, f.warehouse._id, -4);
    await expect(sendBack(bill, 4)).rejects.toThrow(/Not enough stock/);
    expect(await qtyOf(f.ajwa._id, f.warehouse._id)).toBe(2);
    company.allowNegativeStock = true;
    const second = await sendBack(bill, 4);
    expect(await qtyOf(f.ajwa._id, f.warehouse._id)).toBe(-2);
    company.allowNegativeStock = false;

    await purchaseReturns.cancel(second._id.toString(), { reason: 'Changed our mind' }, admin);
    await purchaseReturns.cancel(debit._id.toString(), { reason: 'Changed our mind' }, admin);
    expect(await qtyOf(f.ajwa._id, f.warehouse._id)).toBe(6 - 4 + 4 + 4 - 4);
    expect(await balanceOf(f.farm.account._id)).toBe(-63);
    expect(await balanceOf(await systemAccount(SYSTEM_ACCOUNTS.PURCHASE_RETURNS.key))).toBe(0);
    expect(await reload<Bought>(PurchaseInvoice.name, bill._id)).toMatchObject({ returnedQty: 0, creditedAmount: 0, balance: 63 });
    await expectBalancesMatchEntries();
  });

  it('cancel restores everything, but not when the restocked goods were since sold', async () => {
    const f = await fixtures();
    const invoice = await sale(f);
    const credit = await giveBack(invoice, 3);

    // Sell every unit now in the van: the 3 that came back are gone.
    await postStock(f.ajwa._id, f.van._id, -43);
    await expect(salesReturns.cancel(credit._id.toString(), { reason: 'Customer kept it' }, admin)).rejects.toThrow(
      /Not enough stock/,
    );
    expect(await reload<Sold>(SalesInvoice.name, invoice._id)).toMatchObject({ returnedQty: 3, creditedAmount: 63, balance: 147 });
    expect((await reload<{ status: string }>(SalesReturn.name, credit._id)).status).toBe(VoucherStatus.POSTED);
    await postStock(f.ajwa._id, f.van._id, 43);

    const cancelled = await salesReturns.cancel(credit._id.toString(), { reason: 'Customer kept it' }, admin);
    expect(cancelled.status).toBe(VoucherStatus.CANCELLED);
    expect(await qtyOf(f.ajwa._id, f.van._id)).toBe(40);
    expect(await balanceOf(f.shop.account._id)).toBe(210);
    expect(await balanceOf(await systemAccount(SYSTEM_ACCOUNTS.SALES_RETURNS.key))).toBe(0);
    expect(await balanceOf(await systemAccount(SYSTEM_ACCOUNTS.VAT_OUTPUT.key))).toBe(-10);
    expect(await reload<Sold>(SalesInvoice.name, invoice._id)).toMatchObject({
      returnedQty: 0,
      returnedAmount: 0,
      creditedAmount: 0,
      balance: 210,
      paymentStatus: PaymentStatus.UNPAID,
    });
    await expect(salesReturns.cancel(credit._id.toString(), { reason: 'Again please' }, admin)).rejects.toThrow(/is cancelled/);
    // The quantity is returnable again.
    await expect(giveBack(invoice, 10)).resolves.toBeDefined();
    await expectBalancesMatchEntries();
  });

  it('edit reverses and reposts, audits the change and refuses a no-change edit', async () => {
    const f = await fixtures();
    const invoice = await sale(f);
    const credit = await giveBack(invoice, 3);
    const id = credit._id.toString();

    await expect(salesReturns.update(id, { reason: 'Damaged' }, admin)).rejects.toThrow('No changes to save');
    const edited = await salesReturns.update(
      id,
      { lines: [{ invoiceLineId: invoice.lines[0]._id!.toString(), qty: 5 }], changeNote: 'Counted again' },
      admin,
    );

    expect(edited.netTotal).toBe(105);
    expect(await qtyOf(f.ajwa._id, f.van._id)).toBe(45);
    expect(await balanceOf(f.shop.account._id)).toBe(105);
    expect(await reload<Sold>(SalesInvoice.name, invoice._id)).toMatchObject({
      returnedQty: 5,
      returnedAmount: 105,
      creditedAmount: 105,
      balance: 105,
    });
    const audit = await model<{ changes: { label: string; from: string; to: string }[]; reason: string }>(AuditLog.name)
      .findOne({ entityId: credit._id, action: 'updated' })
      .lean()
      .exec();
    expect(audit!.reason).toBe('Counted again');
    expect(audit!.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Ajwa', from: '3', to: '5' })]),
    );
    await expectBalancesMatchEntries();
  });

  it("refuses to edit or cancel once the credit was applied somewhere else", async () => {
    const f = await fixtures();
    const first = await sale(f);
    const second = await sale(f);
    const credit = await giveBack(first, 3);
    const auto = (await allocations.forPayment(SALES_RETURN_ENTITY_TYPE, credit._id))[0];
    await allocations.reverse(auto.id, 'Wrong invoice', admin);
    await allocations.create(
      {
        paymentVoucherType: SALES_RETURN_ENTITY_TYPE,
        paymentVoucherId: credit._id.toString(),
        paymentLineIndex: 0,
        targetType: AllocationTargetType.SALES_INVOICE,
        targetId: second._id.toString(),
        amount: 20,
      },
      admin,
    );

    await expect(salesReturns.cancel(credit._id.toString(), { reason: 'No longer needed' }, admin)).rejects.toThrow(
      /credit applied to SI-0002/,
    );
    await expect(salesReturns.update(credit._id.toString(), { reason: 'Other reason' }, admin)).rejects.toThrow(
      /credit applied to SI-0002/,
    );
    expect((await reload<{ status: string }>(SalesReturn.name, credit._id)).status).toBe(VoucherStatus.POSTED);
  });

  it('refunds the credit left on account in cash, and cancelling the refund puts it back', async () => {
    const f = await fixtures();
    const invoice = await sale(f, { payNow: { method: 'cash', accountId: f.cash._id.toString(), amount: 200 } });
    const credit = await giveBack(invoice, 3); // 63 credit, 10 cleared the invoice, 53 on account
    const id = credit._id.toString();
    const cashBefore = await balanceOf(f.cash._id);

    await expect(
      salesReturns.refund(id, { voucherDate: '2026-03-12', accountId: f.cash._id.toString(), amount: 60, acknowledgeWarnings: true }, admin),
    ).rejects.toThrow(/Only 53.00 is left/);
    const refunded = await salesReturns.refund(
      id,
      { voucherDate: '2026-03-12', accountId: f.cash._id.toString(), acknowledgeWarnings: true },
      admin,
    );
    expect(refunded).toMatchObject({ refundedAmount: 53 });
    expect(refunded.refunds[0].voucherNo).toBe('CP-0001');
    expect(await balanceOf(f.shop.account._id)).toBe(0);
    expect(await balanceOf(f.cash._id)).toBe(cashBefore - 53);
    expect(await salesReturns.detail(id, admin)).toMatchObject({ onAccount: 0, refundedAmount: 53 });
    expect(await allocations.unallocatedPayments(f.shop.party._id.toString())).toEqual([]);
    await expect(salesReturns.cancel(id, { reason: 'Customer kept it' }, admin)).rejects.toThrow(/refunded in cash/);

    const undone = await salesReturns.cancelRefund(id, refunded.refunds[0].voucherId.toString(), { reason: 'Paid by mistake' }, admin);
    expect(undone.refundedAmount).toBe(0);
    expect(await balanceOf(f.shop.account._id)).toBe(-53);
    expect(await balanceOf(f.cash._id)).toBe(cashBefore);
    expect(await salesReturns.detail(id, admin)).toMatchObject({ onAccount: 53 });
    await expectBalancesMatchEntries();
  });

  it('a purchase return refund is a cash receipt from the supplier', async () => {
    const f = await fixtures();
    const invoice = await purchase(f);
    const debit = await sendBack(invoice, 3); // 18.90
    const auto = (await allocations.forPayment(PURCHASE_RETURN_ENTITY_TYPE, debit._id))[0];
    await allocations.reverse(auto.id, 'Supplier already paid', admin);

    const refunded = await purchaseReturns.refund(
      debit._id.toString(),
      { voucherDate: '2026-03-12', accountId: f.cash._id.toString(), amount: 18.9 },
      admin,
    );
    expect(refunded.refunds[0].voucherNo).toBe('CR000001');
    expect(await balanceOf(f.cash._id)).toBe(18.9);
    expect(await purchaseReturns.detail(debit._id.toString(), admin)).toMatchObject({ onAccount: 0 });
    await expectBalancesMatchEntries();
  });

  it("an invoice with active returns can't be edited or cancelled", async () => {
    const f = await fixtures();
    const invoice = await sale(f);
    const credit = await giveBack(invoice, 1);

    await expect(salesInvoices.cancel(invoice._id.toString(), { reason: 'Entered twice' }, admin)).rejects.toThrow(
      /has sales returns/,
    );
    await expect(salesInvoices.update(invoice._id.toString(), { remarks: 'Changed' }, admin)).rejects.toThrow(
      /has sales returns/,
    );
    await salesReturns.cancel(credit._id.toString(), { reason: 'Kept it' }, admin);
    await expect(salesInvoices.update(invoice._id.toString(), { remarks: 'Changed' }, admin)).resolves.toBeDefined();

    const bill = await purchase(f);
    await sendBack(bill, 1);
    await expect(purchaseInvoices.cancel(bill._id.toString(), { reason: 'Entered twice' }, admin)).rejects.toThrow(
      /has purchase returns/,
    );
  });

  it('a salesman reads only returns of his own invoices and cannot create one', async () => {
    const f = await fixtures();
    const mine = await sale(f, { locationId: undefined }, f.salesman);
    const notMine = await sale(f, {}, admin, f.other);
    const theirs = await giveBack(mine, 1);
    await giveBack(notMine, 1);

    tokenUser = f.salesman;
    const server = app.getHttpServer();
    const list = await request(server).get('/sales-returns').expect(200);
    expect(list.body.items.map((row: { voucherNo: string }) => row.voucherNo)).toEqual([theirs.voucherNo]);
    // No cost back without products:view-cost.
    const one = await request(server).get(`/sales-returns/${theirs._id.toString()}`).expect(200);
    expect(one.body.lines[0].unitCost).toBeUndefined();
    await request(server).get(`/sales-returns/${(await model(SalesReturn.name).findOne({ invoiceId: notMine._id }))!._id.toString()}`).expect(404);
    await request(server)
      .post('/sales-returns')
      .send({
        date: '2026-03-10',
        salesInvoiceId: mine._id.toString(),
        reason: 'Damaged',
        lines: [{ invoiceLineId: mine.lines[0]._id!.toString(), qty: 1 }],
      })
      .expect(403);
    await request(server).get('/purchase-returns').expect(403);
  });

  it('the Accountant role can read and write both kinds of return', async () => {
    expect(ACCOUNTANT_PERMISSIONS).toEqual(
      expect.arrayContaining([
        Permission.SALES_RETURNS_READ,
        Permission.SALES_RETURNS_CREATE,
        Permission.SALES_RETURNS_EDIT,
        Permission.SALES_RETURNS_CANCEL,
        Permission.PURCHASE_RETURNS_READ,
        Permission.PURCHASE_RETURNS_CREATE,
        Permission.PURCHASE_RETURNS_EDIT,
        Permission.PURCHASE_RETURNS_CANCEL,
      ]),
    );
    expect(VAN_SALESMAN_PERMISSIONS).toContain(Permission.SALES_RETURNS_READ);
    expect(VAN_SALESMAN_PERMISSIONS).not.toContain(Permission.SALES_RETURNS_CREATE);
  });

  it('prints a CREDIT NOTE and a DEBIT NOTE', async () => {
    const f = await fixtures();
    const credit = await giveBack(await sale(f), 3);
    const debit = await sendBack(await purchase(f), 4);

    const creditPdf = await salesReturns.print(credit._id.toString(), admin);
    expect(creditPdf.filename).toBe('SR-0001.pdf');
    expect(creditPdf.buffer.length).toBeGreaterThan(500);
    const text = JSON.stringify(creditPdf.definition);
    expect(text).toContain('CREDIT NOTE');
    expect(text).toContain('SI-0001');
    expect(text).toContain('100123456700003');
    expect(text).toContain('100999999900003');

    const debitPdf = await purchaseReturns.print(debit._id.toString(), admin);
    const debitText = JSON.stringify(debitPdf.definition);
    expect(debitText).toContain('DEBIT NOTE');
    expect(debitText).toContain('PI-0001');
    expect(debitText).toContain('INV-77');
    expect(debitText).toContain('100888888800003');
  });
});

const SCHEMAS = new Map<string, unknown>([
  [SalesInvoice.name, SalesInvoiceSchema],
  [PurchaseInvoice.name, PurchaseInvoiceSchema],
  [SalesReturn.name, SalesReturnSchema],
  [PurchaseReturn.name, PurchaseReturnSchema],
  [CashReceipt.name, CashReceiptSchema],
  [CashPayment.name, CashPaymentSchema],
  [Allocation.name, AllocationSchema],
  [StockEntry.name, StockEntrySchema],
  [StockBalance.name, StockBalanceSchema],
  [Product.name, ProductSchema],
  [ProductGroup.name, ProductGroupSchema],
  [Unit.name, UnitSchema],
  [Party.name, PartySchema],
  [Location.name, LocationSchema],
  [LedgerEntry.name, LedgerEntrySchema],
  [LedgerAccount.name, LedgerAccountSchema],
  [Counter.name, CounterSchema],
  [AuditLog.name, AuditLogSchema],
  [Comment.name, CommentSchema],
  [User.name, UserSchema],
  [Role.name, RoleSchema],
  [OpeningBalance.name, OpeningBalanceSchema],
]);
