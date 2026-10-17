import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import request from 'supertest';
import { createVoucherHarness, makeUser, type VoucherHarness } from '../../../test/voucher-test-module.js';
import { LedgerAccountType, type LedgerAccountDocument } from '../accounting/ledger-accounts/schemas/ledger-account.schema.js';
import type { CashierDocument } from '../cashier/schemas/cashier.schema.js';
import { User, type UserDocument } from '../users/schemas/user.schema.js';
import { Location, type LocationDocument, LocationType } from '../location/schemas/location.schema.js';
import { ReportsController } from './reports.controller.js';
import { REQUIRE_PERMISSION_KEY } from '../../common/decorators/require-permission.decorator.js';
import { ACCOUNTANT_PERMISSIONS, DataScope, Permission } from '../roles/permissions.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';

const { CASH, WALLET, BANK, PARTY } = LedgerAccountType;

describe('Salesman collections report', () => {
  let h: VoucherHarness;
  let userModel: Model<UserDocument>;
  let locationModel: Model<LocationDocument>;
  const office = makeUser('Office');
  let van1: CashierDocument;
  let van2: CashierDocument;
  let desk: CashierDocument;
  let van1Cash: LedgerAccountDocument;
  let van2Cash: LedgerAccountDocument;
  let wallet: LedgerAccountDocument;
  let officeCash: LedgerAccountDocument;
  let bank: LedgerAccountDocument;
  let customer: LedgerAccountDocument;

  beforeAll(async () => {
    h = await createVoucherHarness('salesman_collections');
    userModel = h.moduleRef.get(getModelToken(User.name));
    locationModel = h.moduleRef.get(getModelToken(Location.name));
  }, 120_000);

  afterAll(async () => {
    await h?.app.close();
  });

  beforeEach(async () => {
    van1 = await h.cashiers.create({ name: 'Van 1' }, office);
    van2 = await h.cashiers.create({ name: 'Van 2' }, office);
    desk = await h.cashiers.create({ name: 'Office Desk' }, office);
    van1Cash = await h.makeAccount('CASH-0001', CASH, 0, 'Van 1 Cash');
    van2Cash = await h.makeAccount('CASH-0002', CASH, 0, 'Van 2 Cash');
    officeCash = await h.makeAccount('CASH-0003', CASH, 0, 'Office Cash');
    wallet = await h.makeAccount('WAL-0001', WALLET, 0, 'Van Wallet');
    bank = await h.makeAccount('BNK-0001', BANK, 0, 'ADCB');
    customer = await h.makeAccount('CUS-0001', PARTY, 0, 'Ali Traders');
  });

  afterEach(async () => {
    h.harness.tokenUser = makeUser('Sachin');
    await h.reset();
    await userModel.deleteMany({}).exec();
    await locationModel.deleteMany({}).exec();
  });

  const receipt = (cashier: CashierDocument, into: LedgerAccountDocument, amount: number, date: string) =>
    h.receipts.create(
      {
        voucherDate: date,
        cashAccountId: into.id as string,
        cashierId: cashier.id as string,
        lines: [{ accountId: customer.id as string, amount }],
      },
      office,
    );

  const handover = (cashier: CashierDocument, from: LedgerAccountDocument, amount: number, date: string) =>
    h.handovers.create(
      {
        voucherDate: date,
        fromAccountId: from.id as string,
        toAccountId: officeCash.id as string,
        amount,
        handedByCashierId: cashier.id as string,
        receivedByCashierId: desk.id as string,
      },
      office,
    );

  const report = (query: Record<string, string> = {}) => h.collections.report(query, office);
  const rowOf = async (cashier: CashierDocument, query: Record<string, string> = {}) =>
    (await report(query)).rows.find((row) => row.cashier.id === cashier.id);

  /** Three days for Van 1: cash, wallet and bank receipts, part handed over each day. */
  async function threeDays() {
    await receipt(van1, van1Cash, 500, '2026-10-01');
    await receipt(van1, bank, 200, '2026-10-01');
    await handover(van1, van1Cash, 300, '2026-10-01');
    await receipt(van1, van1Cash, 400, '2026-10-02');
    await receipt(van1, wallet, 100, '2026-10-02');
    await handover(van1, van1Cash, 500, '2026-10-02');
    const third = await receipt(van1, van1Cash, 250, '2026-10-03');
    const lastHandover = await handover(van1, van1Cash, 50, '2026-10-03');
    await receipt(van2, van2Cash, 80, '2026-10-02');
    return { third, lastHandover };
  }

  it('keeps pending cash equal to cash collected minus handed over, across days', async () => {
    await threeDays();

    // Whole period: cash 500+400+100+250 = 1250, handed 850, bank 200 separate.
    expect(await rowOf(van1)).toMatchObject({
      openingPending: 0,
      collectedCash: 1250,
      collectedBank: 200,
      handedOver: 850,
      closingPending: 400,
      receiptCount: 5,
      handoverCount: 3,
    });

    // Day by day: each closing is the next opening.
    const day1 = await rowOf(van1, { dateFrom: '2026-10-01', dateTo: '2026-10-01' });
    const day2 = await rowOf(van1, { dateFrom: '2026-10-02', dateTo: '2026-10-02' });
    const day3 = await rowOf(van1, { dateFrom: '2026-10-03', dateTo: '2026-10-03' });
    expect(day1).toMatchObject({ openingPending: 0, collectedCash: 500, collectedBank: 200, handedOver: 300, closingPending: 200 });
    expect(day2).toMatchObject({ openingPending: 200, collectedCash: 500, handedOver: 500, closingPending: 200 });
    expect(day3).toMatchObject({ openingPending: 200, collectedCash: 250, handedOver: 50, closingPending: 400 });

    const all = await report({ dateFrom: '2026-10-02', dateTo: '2026-10-03' });
    expect(all.rows.map((row) => row.cashier.name)).toEqual(['Van 1', 'Van 2']);
    expect(all.totals).toMatchObject({ openingPending: 200, collectedCash: 830, handedOver: 550, closingPending: 480 });
  });

  it('updates when a receipt or a handover is cancelled or edited', async () => {
    const { third, lastHandover } = await threeDays();
    await h.receipts.cancel(third.id as string, { reason: 'Duplicate' }, office);
    expect(await rowOf(van1)).toMatchObject({ collectedCash: 1000, receiptCount: 4, closingPending: 150 });

    await h.handovers.cancel(lastHandover.id as string, { reason: 'Never arrived' }, office);
    expect(await rowOf(van1)).toMatchObject({ handedOver: 800, handoverCount: 2, closingPending: 200 });

    const [firstHandover] = (await h.handovers.findAll({ handedByCashierId: van1.id as string, sortDir: 'asc' })).items;
    await h.handovers.update(firstHandover.id, { amount: 250 }, office);
    expect(await rowOf(van1)).toMatchObject({ handedOver: 750, closingPending: 250 });
  });

  it('matches the ledger: pending cash is what the van accounts still hold', async () => {
    await threeDays();
    // Van 1 collects into its cash account and its wallet only, so they hold its pending cash.
    const held = (await h.balanceOf(van1Cash)) + (await h.balanceOf(wallet));
    expect((await rowOf(van1))!.closingPending).toBe(held);
    for (const account of await h.models.account.find().lean().exec()) {
      const entries = (await h.models.entry.find({ accountId: account._id }).lean().exec()) as unknown as {
        debit: number;
        credit: number;
      }[];
      const net = Math.round(entries.reduce((sum, entry) => sum + entry.debit - entry.credit, 0) * 100) / 100;
      expect([account.code, account.balance]).toEqual([account.code, net]);
    }
  });

  it('filters by cashier and location, and validates the range', async () => {
    await threeDays();
    expect((await report({ cashierId: van2.id as string })).rows.map((row) => row.cashier.name)).toEqual(['Van 2']);
    // Asked for by id: listed even with nothing to show.
    expect((await report({ cashierId: desk.id as string })).rows).toMatchObject([
      { cashier: { name: 'Office Desk' }, closingPending: 0, receiptCount: 0 },
    ]);

    const store = await locationModel.create({ code: 'VAN-0001', name: 'Van 2 Route', type: LocationType.VAN });
    await h.cashiers.update(van2.id as string, { locationId: store.id as string }, office);
    const byLocation = await report({ locationId: store.id as string });
    expect(byLocation.rows).toMatchObject([{ cashier: { name: 'Van 2', location: { name: 'Van 2 Route' } } }]);

    await expect(report({ dateFrom: '2026-10-05', dateTo: '2026-10-01' })).rejects.toThrow(/dateFrom/);
  });

  it('details list the receipts and handovers behind a row', async () => {
    await threeDays();
    const details = await h.collections.details(van1.id as string, { dateFrom: '2026-10-02', dateTo: '2026-10-02' }, office);
    expect(details.row).toMatchObject({ openingPending: 200, closingPending: 200 });
    expect(details.receipts.map((r) => [r.account.name, r.amount, r.countsAsPending])).toEqual([
      ['Van 1 Cash', 400, true],
      ['Van Wallet', 100, true],
    ]);
    expect(details.handovers).toMatchObject([
      { voucherNo: 'CH-0002', fromAccount: { name: 'Van 1 Cash' }, toAccount: { name: 'Office Cash' }, receivedBy: { name: 'Office Desk' }, amount: 500 },
    ]);
    const bankDay = await h.collections.details(van1.id as string, { dateFrom: '2026-10-01', dateTo: '2026-10-01' }, office);
    expect(bankDay.receipts.find((r) => r.paymentMethod === 'bank')).toMatchObject({ amount: 200, countsAsPending: false });
  });

  describe('access', () => {
    async function scopedSalesman(): Promise<AuthenticatedUser> {
      const user = await userModel.create({ email: 'r@ala.ae', passwordHash: 'x', name: 'Rashid', role: new Types.ObjectId() });
      await h.cashiers.update(van1.id as string, { linkedUserId: user.id as string }, office);
      return {
        ...makeUser('Rashid', [Permission.REPORTS_SALESMAN]),
        id: user.id as string,
        dataScope: DataScope.OWN,
      };
    }

    it('gives a scoped user only their own row, and 404 on another cashier', async () => {
      await threeDays();
      h.harness.tokenUser = await scopedSalesman();
      const server = h.app.getHttpServer();

      const res = await request(server).get('/reports/salesman-collections');
      expect(res.status).toBe(200);
      expect(res.body.rows.map((row: { cashier: { name: string } }) => row.cashier.name)).toEqual(['Van 1']);
      const asked = await request(server).get('/reports/salesman-collections').query({ cashierId: van2.id });
      expect(asked.body.rows).toEqual([]);
      expect((await request(server).get(`/reports/salesman-collections/${van1.id}`)).status).toBe(200);
      expect((await request(server).get(`/reports/salesman-collections/${van2.id}`)).status).toBe(404);
    });

    it('needs reports:salesman; the Accountant has it', async () => {
      h.harness.tokenUser = makeUser('Nobody', []);
      expect((await request(h.app.getHttpServer()).get('/reports/salesman-collections')).status).toBe(403);
      for (const method of ['salesmanCollectionsReport', 'salesmanCollectionDetails'] as const) {
        expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, ReportsController.prototype[method])).toEqual([
          Permission.REPORTS_SALESMAN,
        ]);
      }
      expect(ACCOUNTANT_PERMISSIONS).toContain(Permission.REPORTS_SALESMAN);
    });
  });
});
