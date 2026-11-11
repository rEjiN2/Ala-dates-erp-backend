import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Types, type Connection, type Model } from 'mongoose';
import { mongooseTestRoot } from '../../../../test/mongo-test-db.js';
import { CostService } from './cost.service.js';
import { CostLayer, CostLayerSchema } from './schemas/cost-layer.schema.js';
import { LayerConsumption, LayerConsumptionSchema } from './schemas/layer-consumption.schema.js';
import { StockService } from '../stock.service.js';
import { InTransitRegistry } from '../pending-receipt.js';
import { StockEntry, StockEntrySchema } from '../schemas/stock-entry.schema.js';
import { StockBalance, StockBalanceSchema } from '../schemas/stock-balance.schema.js';
import { OpeningStockService } from '../opening-stock/opening-stock.service.js';
import { OpeningStock, OpeningStockSchema } from '../opening-stock/schemas/opening-stock.schema.js';
import { BundlingService } from '../bundling/bundling.service.js';
import { Bundling, BundlingMode, BundlingSchema } from '../bundling/schemas/bundling.schema.js';
import { BundleRecipe, BundleRecipeSchema } from '../bundling/schemas/bundle-recipe.schema.js';
import { StockCountService } from '../stock-count/stock-count.service.js';
import { StockCount, StockCountSchema } from '../stock-count/schemas/stock-count.schema.js';
import { StockTransferService } from '../transfers/stock-transfer.service.js';
import { StockTransfer, StockTransferSchema } from '../transfers/schemas/stock-transfer.schema.js';
import { BatchExpiryService } from '../../reports/batch-expiry.service.js';
import { SalesInvoiceService } from '../../sales/sales-invoices/sales-invoice.service.js';
import { SalesInvoice, SalesInvoiceSchema } from '../../sales/sales-invoices/schemas/sales-invoice.schema.js';
import { PurchaseInvoiceService } from '../../purchase/purchase-invoices/purchase-invoice.service.js';
import { PurchaseInvoice, PurchaseInvoiceSchema } from '../../purchase/purchase-invoices/schemas/purchase-invoice.schema.js';
import { ReturnService } from '../../accounting/returns/return.service.js';
import { SalesReturnService } from '../../accounting/returns/sales-return.service.js';
import { PurchaseReturnService } from '../../accounting/returns/purchase-return.service.js';
import {
  PurchaseReturn,
  PurchaseReturnSchema,
  SalesReturn,
  SalesReturnSchema,
} from '../../accounting/returns/schemas/return.schema.js';
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
import { LedgerAccount, LedgerAccountSchema, LedgerAccountType } from '../../accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { CashReceiptService } from '../../accounting/cash-receipts/cash-receipt.service.js';
import { CashPayment, CashPaymentSchema } from '../../accounting/cash-payments/schemas/cash-payment.schema.js';
import { CashReceipt, CashReceiptSchema } from '../../accounting/cash-receipts/schemas/cash-receipt.schema.js';
import { AllocationService } from '../../accounting/allocations/allocation.service.js';
import { Allocation, AllocationSchema } from '../../accounting/allocations/schemas/allocation.schema.js';
import { OpeningBalance, OpeningBalanceSchema } from '../../accounting/opening-balances/schemas/opening-balance.schema.js';
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
import { runInTransaction } from '../../../common/utils/transaction.util.js';
import { ADMIN_PERMISSIONS, Permission } from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';

type Ref = { _id: Types.ObjectId };

const SCHEMAS: [{ name: string }, unknown][] = [
  [CostLayer, CostLayerSchema],
  [LayerConsumption, LayerConsumptionSchema],
  [StockEntry, StockEntrySchema],
  [StockBalance, StockBalanceSchema],
  [OpeningStock, OpeningStockSchema],
  [Bundling, BundlingSchema],
  [BundleRecipe, BundleRecipeSchema],
  [StockCount, StockCountSchema],
  [StockTransfer, StockTransferSchema],
  [SalesInvoice, SalesInvoiceSchema],
  [PurchaseInvoice, PurchaseInvoiceSchema],
  [SalesReturn, SalesReturnSchema],
  [PurchaseReturn, PurchaseReturnSchema],
  [CashReceipt, CashReceiptSchema],
  [CashPayment, CashPaymentSchema],
  [Allocation, AllocationSchema],
  [Product, ProductSchema],
  [ProductGroup, ProductGroupSchema],
  [Unit, UnitSchema],
  [Party, PartySchema],
  [Location, LocationSchema],
  [LedgerEntry, LedgerEntrySchema],
  [LedgerAccount, LedgerAccountSchema],
  [Counter, CounterSchema],
  [AuditLog, AuditLogSchema],
  [Comment, CommentSchema],
  [User, UserSchema],
  [Role, RoleSchema],
  [OpeningBalance, OpeningBalanceSchema],
];

const user = (name: string, permissions: string[] = [...ADMIN_PERMISSIONS]): AuthenticatedUser => ({
  id: new Types.ObjectId().toString(),
  email: `${name.toLowerCase()}@example.com`,
  name,
  role: { id: new Types.ObjectId().toString(), name: 'r' },
  permissions,
});

describe('FIFO costing across every voucher type', () => {
  let moduleRef: TestingModule;
  const admin = user('Admin');
  const approver = user('Approver');
  const model = <T>(name: string) => moduleRef.get<Model<T>>(getModelToken(name));
  const get = <T>(token: new (...args: never[]) => T) => moduleRef.get<T>(token);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('costing_mixed'),
        MongooseModule.forFeature(SCHEMAS.map(([m, schema]) => ({ name: m.name, schema: schema as never }))),
      ],
      providers: [
        StockService,
        CostService,
        InTransitRegistry,
        OpeningStockService,
        BundlingService,
        StockCountService,
        StockTransferService,
        BatchExpiryService,
        SalesInvoiceService,
        PurchaseInvoiceService,
        ReturnService,
        SalesReturnService,
        PurchaseReturnService,
        CashReceiptService,
        AllocationService,
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
          useValue: { ensure: async () => ({ allowNegativeStock: false, defaultChequesInHandAccountId: null }) },
        },
        { provide: FilesService, useValue: {} },
      ],
    }).compile();
    await moduleRef.init();
    await Promise.all(SCHEMAS.map(([m]) => model(m.name).init()));
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  const layersOf = (productId: Types.ObjectId) =>
    model<{ _id: Types.ObjectId; qtyRemaining: number; qtyIn: number; unitCost: number; expiryDate: Date | null; sourceType: string; voidedAt: Date | null }>(
      CostLayer.name,
    )
      .find({ productId, voidedAt: null })
      .sort({ date: 1, createdAt: 1, _id: 1 })
      .lean()
      .exec();
  const remaining = async (productId: Types.ObjectId) => (await layersOf(productId)).map((layer) => layer.qtyRemaining);
  const qtyAt = async (productId: Types.ObjectId, locationId: Types.ObjectId) =>
    (await model<{ qty: number }>(StockBalance.name).findOne({ productId, locationId }).lean().exec())?.qty ?? 0;
  /** sum(layer qtyRemaining) = total StockBalance + in transit, for every product. */
  const expectInvariant = async () => expect(await get(CostService).reconcile()).toEqual([]);

  it('keeps layers equal to stock on hand plus in transit through purchases, sales, returns, bundling, undo, counts, transfers and cancels', async () => {
    const sales = get(SalesInvoiceService);
    const purchases = get(PurchaseInvoiceService);
    const salesReturns = get(SalesReturnService);
    const purchaseReturns = get(PurchaseReturnService);
    const bundling = get(BundlingService);
    const counts = get(StockCountService);
    const transfers = get(StockTransferService);
    const opening = get(OpeningStockService);
    const batchExpiry = get(BatchExpiryService);

    // ---- fixtures
    const role = await model(Role.name).create({ name: 'admin role', permissions: admin.permissions });
    await model(User.name).create({ _id: new Types.ObjectId(admin.id), email: admin.email, name: 'Admin', passwordHash: 'x', role: role._id });
    const group = await model(ProductGroup.name).create({ code: 'PG-0001', name: 'Dates' });
    const unit = await model(Unit.name).create({ name: 'Kilogram', symbol: 'kg' });
    const product = async (code: string, type: ProductType, salePrice: number) =>
      (await model(Product.name).create({
        code,
        name: code,
        productGroupId: group._id,
        unitId: unit._id,
        type,
        salePrice,
        purchasePrice: 1,
        vatRate: 5,
      })) as unknown as Ref;
    const A = await product('PRD-0001', ProductType.STOCK, 20);
    const B = await product('PRD-0002', ProductType.STOCK, 5);
    const gift = await product('PRD-0003', ProductType.BUNDLE, 50);
    const location = async (code: string, type: LocationType) =>
      (await model(Location.name).create({ code, name: code, type, status: LocationStatus.ACTIVE })) as unknown as Ref;
    const wh = await location('WH-0001', LocationType.WAREHOUSE);
    const van = await location('VAN-0001', LocationType.VAN);
    const party = async (kind: PartyKind, code: string, accountType: LedgerAccountType) => {
      const account = await model(LedgerAccount.name).create({ code, name: code, type: accountType });
      return (await model(Party.name).create({
        code,
        kind,
        name: code,
        status: PartyStatus.ACTIVE,
        creditDays: 15,
        ledgerAccountId: account._id,
      })) as unknown as Ref;
    };
    const shop = await party(PartyKind.CUSTOMER, 'CUS-0001', LedgerAccountType.PARTY);
    const farm = await party(PartyKind.SUPPLIER, 'SUP-0001', LedgerAccountType.SUPPLIER);

    // ---- purchases and opening stock: A 100 @10 (expires 2026-12-31) and 100 @12; B 50 @1 (opening) and 100 @2
    const bill = (billNo: string, date: string, productId: Types.ObjectId, qty: number, rate: number, extra: Record<string, unknown> = {}) =>
      purchases.create(
        { date, supplierId: farm._id.toString(), locationId: wh._id.toString(), billNo, lines: [{ productId: productId.toString(), qty, rate, ...extra }] },
        admin,
      );
    await opening.create(
      { asOfDate: '2026-01-01', locationId: wh._id.toString(), lines: [{ productId: B._id.toString(), qty: 50, unitCost: 1 }] },
      admin,
    );
    const pi1 = await bill('B-1', '2026-03-01', A._id, 100, 10, { expiryDate: '2026-12-31' });
    const pi2 = await bill('B-2', '2026-03-02', A._id, 100, 12);
    const pi3 = await bill('B-3', '2026-03-03', B._id, 100, 2);
    await expectInvariant();

    // ---- transfers never touch layers: 60 received at the van, 5 left in transit
    const moved = await transfers.create(
      { date: '2026-03-04', fromLocationId: wh._id.toString(), toLocationId: van._id.toString(), lines: [{ productId: A._id.toString(), qty: 60 }] },
      admin,
    );
    await transfers.receive(moved.id, {}, admin);
    await transfers.create(
      { date: '2026-03-04', fromLocationId: wh._id.toString(), toLocationId: van._id.toString(), lines: [{ productId: A._id.toString(), qty: 5 }] },
      admin,
    );
    expect(await remaining(A._id)).toEqual([100, 100]);
    await expectInvariant();

    // ---- a sale of 40 at the van costs 400 from the oldest layer
    const si1 = await sales.create(
      { date: '2026-03-05', customerId: shop._id.toString(), locationId: van._id.toString(), lines: [{ productId: A._id.toString(), qty: 40 }] },
      admin,
    );
    expect(si1).toMatchObject({ costTotal: 400, margin: 400 });
    expect(await remaining(A._id)).toEqual([60, 100]);

    // ---- returns: 10 restocked go back to the layer the sale took them from; 5 not restocked stay consumed
    const lineId = si1.lines[0]._id!.toString();
    const sr1 = await salesReturns.create(
      { date: '2026-03-10', salesInvoiceId: si1._id.toString(), reason: 'Damaged', lines: [{ invoiceLineId: lineId, qty: 10 }] },
      admin,
    );
    expect(await remaining(A._id)).toEqual([70, 100]);
    await salesReturns.create(
      { date: '2026-03-10', salesInvoiceId: si1._id.toString(), reason: 'Spoiled', lines: [{ invoiceLineId: lineId, qty: 5, restock: false }] },
      admin,
    );
    expect(await remaining(A._id)).toEqual([70, 100]);
    await expectInvariant();

    // cancelling the restocking return takes the same units out of the same layer again
    await salesReturns.cancel(sr1._id.toString(), { reason: 'Not returned after all' }, admin);
    expect(await remaining(A._id)).toEqual([60, 100]);
    await salesReturns.create(
      { date: '2026-03-10', salesInvoiceId: si1._id.toString(), reason: 'Damaged', lines: [{ invoiceLineId: lineId, qty: 10 }] },
      admin,
    );
    expect(await remaining(A._id)).toEqual([70, 100]);
    await expectInvariant();

    // a purchase return takes its own bill's layer first, though an older one has stock
    await purchaseReturns.create(
      { date: '2026-03-10', purchaseInvoiceId: pi2._id.toString(), reason: 'Wrong grade', lines: [{ invoiceLineId: pi2.lines[0]._id!.toString(), qty: 20 }] },
      admin,
    );
    expect(await remaining(A._id)).toEqual([70, 80]);
    await expectInvariant();

    // ---- bundling: 2 A + 1 B + 1.50 per pack; the cost comes from the batches the parts were taken from
    await bundling.setRecipe(
      gift._id.toString(),
      { components: [{ productId: A._id.toString(), qty: 2 }, { productId: B._id.toString(), qty: 1 }], extraCostPerUnit: 1.5 },
      admin,
    );
    const make = (qty: number, mode = BundlingMode.BUNDLE, date = '2026-03-11') =>
      bundling.create({ date, locationId: wh._id.toString(), mode, bundleProductId: gift._id.toString(), qty }, admin);
    const bundled = await make(10);
    // 20 A from the 10-cost layer (200) + 10 B from the opening 1-cost layer (10) = 210 -> 21 + 1.50
    expect(bundled.costPerUnit).toBe(22.5);
    expect((await layersOf(gift._id))[0]).toMatchObject({ qtyRemaining: 10, unitCost: 22.5, expiryDate: new Date('2026-12-31') });
    expect(await remaining(A._id)).toEqual([50, 80]);
    expect(await remaining(B._id)).toEqual([40, 100]);
    await expectInvariant();

    // batch expiry: soonest first, cost only with products:view-cost
    const report = await batchExpiry.report({ asOf: '2026-12-01', daysAhead: 60 }, admin);
    expect(report.items.map((row) => [row.product.code, row.remaining, row.daysLeft, row.unitCost])).toEqual([
      ['PRD-0001', 50, 30, 10],
      ['PRD-0003', 10, 30, 22.5],
    ]);
    const blind = await batchExpiry.report({ asOf: '2026-12-01', productId: A._id.toString() }, user('Clerk', [Permission.REPORTS_ACCOUNTING]));
    expect(blind.items).toHaveLength(1);
    expect(blind.items[0]).not.toHaveProperty('unitCost');

    // unbundle 4: the bundle layer is consumed, the parts return as new layers at their latest layer cost; undo restores
    const unbundled = await make(4, BundlingMode.UNBUNDLE, '2026-03-12');
    expect(await remaining(gift._id)).toEqual([6]);
    expect((await layersOf(A._id)).at(-1)).toMatchObject({ qtyIn: 8, unitCost: 12 });
    expect((await layersOf(B._id)).at(-1)).toMatchObject({ qtyIn: 4, unitCost: 2 });
    await expectInvariant();
    await bundling.cancel(unbundled.id, { reason: 'Mistake' }, admin);
    expect(await remaining(gift._id)).toEqual([10]);
    expect(await remaining(A._id)).toEqual([50, 80]);
    await expectInvariant();

    // undoing the bundling is blocked while a pack from it was sold, and works once the sale is cancelled
    const si2 = await sales.create(
      { date: '2026-03-13', customerId: shop._id.toString(), locationId: wh._id.toString(), lines: [{ productId: gift._id.toString(), qty: 1 }] },
      admin,
    );
    expect(si2.costTotal).toBe(22.5);
    await expect(bundling.cancel(bundled.id, { reason: 'Undo' }, admin)).rejects.toThrow(
      /Bundling BND-0001 can't be undone: its stock was already used on SI-0002/,
    );
    await sales.cancel(si2._id.toString(), { reason: 'Wrong item' }, admin);
    await bundling.cancel(bundled.id, { reason: 'Undo' }, admin);
    expect(await remaining(A._id)).toEqual([70, 80]);
    expect(await remaining(B._id)).toEqual([50, 100]);
    expect(await remaining(gift._id)).toEqual([]);
    await expectInvariant();

    // ---- counts: a shortage consumes FIFO; an excess adds a layer at the latest cost; cancel reverses
    const count = async (productId: Types.ObjectId, countedQty: number) => {
      const created = await counts.create(
        { date: '2026-03-14', locationId: wh._id.toString(), lines: [{ productId: productId.toString(), countedQty }] },
        admin,
      );
      const submitted = await counts.submit(created.id, admin);
      return counts.approve(submitted.id, {}, approver);
    };
    const shortage = await count(A._id, (await qtyAt(A._id, wh._id)) - 3);
    expect(await remaining(A._id)).toEqual([67, 80]);
    await expectInvariant();
    await counts.cancel(shortage.id, { reason: 'Miscount' }, approver);
    expect(await remaining(A._id)).toEqual([70, 80]);
    const excess = await count(B._id, (await qtyAt(B._id, wh._id)) + 5);
    expect((await layersOf(B._id)).at(-1)).toMatchObject({ qtyIn: 5, unitCost: 2, sourceType: 'stock-count' });
    await expectInvariant();
    await counts.cancel(excess.id, { reason: 'Miscount' }, approver);
    expect(await remaining(B._id)).toEqual([50, 100]);

    // ---- cancels: a bill with sold stock is refused; one with none goes
    await expect(purchases.cancel(pi1._id.toString(), { reason: 'Wrong' }, admin)).rejects.toThrow(/its stock was already used on SI-0001/);
    await purchases.cancel(pi3._id.toString(), { reason: 'Wrong' }, admin);
    expect(await remaining(B._id)).toEqual([50]);
    await expectInvariant();

    // every voucher type that moved stock declared how it costs it
    const types = await model(StockEntry.name).distinct('voucherType');
    expect(types.sort()).toEqual(
      ['bundling', 'opening-stock', 'purchase-invoice', 'purchase-return', 'sales-invoice', 'sales-return', 'stock-count', 'stock-transfer'].sort(),
    );
    expect(await model(StockEntry.name).countDocuments({ costing: null, voucherType: { $ne: 'stock-transfer' } })).toBe(0);
  });

  it('rejects a stock entry with no costing declaration, except stock transfers', async () => {
    const stock = get(StockService);
    const wh = await model(Location.name).create({ code: 'WH-0009', name: 'WH', type: LocationType.WAREHOUSE, status: LocationStatus.ACTIVE });
    const product = await model(Product.name).create({
      code: 'PRD-0009',
      name: 'X',
      productGroupId: new Types.ObjectId(),
      unitId: new Types.ObjectId(),
      type: ProductType.STOCK,
      salePrice: 1,
      purchasePrice: 1,
      vatRate: 5,
    });
    const entry = (voucherType: string, costing?: 'none') => ({
      productId: product._id,
      locationId: wh._id,
      qty: 1,
      date: new Date('2026-03-01'),
      voucherType,
      voucherId: new Types.ObjectId(),
      voucherNo: 'X-1',
      costing,
    });
    const post = (voucherType: string, costing?: 'none') =>
      runInTransaction(moduleRef.get<Connection>(getConnectionToken()), (session) => stock.post([entry(voucherType, costing)], admin, session));

    await expect(post('some-new-voucher')).rejects.toThrow(/no costing declaration/);
    await post('some-new-voucher', 'none');
    await post('stock-transfer');
  });

  it('every service that posts stock declares a costing action', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
    const posting = walk(join(process.cwd(), 'src'))
      .filter((path) => path.endsWith('.ts') && !path.endsWith('.spec.ts') && !path.endsWith('stock.service.ts'))
      .filter((path) => /stockService\s*\.post\(/.test(readFileSync(path, 'utf8')));
    expect(posting.length).toBeGreaterThanOrEqual(6);
    const undeclared = posting.filter((path) => !path.includes('stock-transfer') && !/costing:/.test(readFileSync(path, 'utf8')));
    expect(undeclared).toEqual([]);
  });
});
