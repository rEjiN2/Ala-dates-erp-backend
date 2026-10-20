import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import request from 'supertest';
import { createVoucherHarness, makeUser, type VoucherHarness } from '../../../test/voucher-test-module.js';
import { LedgerAccountType, type LedgerAccountDocument } from '../accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { type CashierDocument, StaffType } from '../cashier/schemas/cashier.schema.js';
import { User, type UserDocument } from '../users/schemas/user.schema.js';
import { Location, type LocationDocument, LocationType } from '../location/schemas/location.schema.js';
import { ReportsController } from './reports.controller.js';
import { REQUIRE_PERMISSION_KEY } from '../../common/decorators/require-permission.decorator.js';
import { ACCOUNTANT_PERMISSIONS, DataScope, Permission } from '../roles/permissions.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';

const { CASH, BANK, PARTY } = LedgerAccountType;

describe('Salesman collections report', () => {
  let h: VoucherHarness;
  let userModel: Model<UserDocument>;
  let locationModel: Model<LocationDocument>;
  const office = makeUser('Office');
  const approver = makeUser('Approver');
  let van1: CashierDocument;
  let van2: CashierDocument;
  let van1Cash: LedgerAccountDocument;
  let van2Cash: LedgerAccountDocument;
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
    van1 = await h.cashiers.create({ name: 'Van 1', staffType: StaffType.VAN_SALESMAN }, office);
    van2 = await h.cashiers.create({ name: 'Van 2', staffType: StaffType.VAN_SALESMAN }, office);
    van1Cash = await h.makeAccount('CASH-0001', CASH, 0, 'Van 1 Cash');
    van2Cash = await h.makeAccount('CASH-0002', CASH, 0, 'Van 2 Cash');
    officeCash = await h.makeAccount('CASH-0003', CASH, 0, 'Office Cash');
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

  const submit = (cashier: CashierDocument, from: LedgerAccountDocument, receiptIds: string[], date: string) =>
    h.handovers.create(
      { voucherDate: date, staffId: cashier.id as string, sourceAccountId: from.id as string, receiptIds, countedCash: 0 },
      office,
    );

  /** Approves, then backdates the approval (and the receipts' settledAt) to `at`. */
  async function approveOn(id: string, receivedCash: number, at: string, varianceReason?: string) {
    await h.handovers.approve(
      id,
      { receivedCash, receivedIntoAccountId: officeCash.id as string, varianceReason },
      approver,
    );
    const when = new Date(at);
    await h.models.handover.updateOne({ _id: id }, { approvedAt: when }).exec();
    await h.models.receipt.updateMany({ handoverId: new Types.ObjectId(id) }, { settledAt: when }).exec();
  }

  const report = (query: Record<string, string> = {}) => h.collections.report(query, office);
  const rowOf = async (cashier: CashierDocument, query: Record<string, string> = {}) =>
    (await report(query)).rows.find((row) => row.cashier.id === cashier.id);

  /**
   * Van 1: day 1 cash 500 + bank 200, handed over and approved that day with
   * 480 received (20 short); day 2 cash 400 + 100, the 400 submitted; day 3
   * cash 250. Van 2: 80 on day 2.
   */
  async function threeDays() {
    const r1 = await receipt(van1, van1Cash, 500, '2026-10-01');
    const r2 = await receipt(van1, bank, 200, '2026-10-01');
    const h1 = await submit(van1, van1Cash, [r1.id, r2.id] as string[], '2026-10-01');
    await approveOn(h1.id as string, 480, '2026-10-01T15:00:00Z', 'Short at count');
    const r3 = await receipt(van1, van1Cash, 400, '2026-10-02');
    await receipt(van1, van1Cash, 100, '2026-10-02');
    const h2 = await submit(van1, van1Cash, [r3.id as string], '2026-10-02');
    const r5 = await receipt(van1, van1Cash, 250, '2026-10-03');
    await receipt(van2, van2Cash, 80, '2026-10-02');
    return { h1, h2, r5 };
  }

  it('tracks unsettled cash through submit and approval, day by day', async () => {
    const { h2 } = await threeDays();

    expect(await rowOf(van1)).toMatchObject({
      unsettledOpening: 0,
      collectedCash: 1250,
      collectedBank: 200,
      pendingApproval: 400,
      settled: 480,
      openShortage: 20,
      unsettledClosing: 750,
      receiptCount: 5,
      handoverCount: 2,
    });

    const day = (d: string) => rowOf(van1, { dateFrom: d, dateTo: d });
    expect(await day('2026-10-01')).toMatchObject({
      unsettledOpening: 0,
      collectedCash: 500,
      collectedBank: 200,
      pendingApproval: 0,
      settled: 480,
      openShortage: 20,
      unsettledClosing: 0,
    });
    expect(await day('2026-10-02')).toMatchObject({ unsettledOpening: 0, collectedCash: 500, pendingApproval: 400, settled: 0, unsettledClosing: 500 });
    expect(await day('2026-10-03')).toMatchObject({ unsettledOpening: 500, collectedCash: 250, unsettledClosing: 750 });

    await approveOn(h2.id as string, 400, '2026-10-03T10:00:00Z');
    expect(await day('2026-10-03')).toMatchObject({ unsettledOpening: 500, pendingApproval: 0, settled: 400, unsettledClosing: 350 });

    const all = await report({ dateFrom: '2026-10-02', dateTo: '2026-10-03' });
    expect(all.rows.map((row) => row.cashier.name)).toEqual(['Van 1', 'Van 2']);
    expect(all.totals).toMatchObject({ collectedCash: 830, settled: 400, unsettledClosing: 430 });
  });

  it('matches the ledger: unsettled cash plus open shortage is what the van account holds', async () => {
    await threeDays();
    const row = (await rowOf(van1))!;
    expect(row.unsettledClosing + row.openShortage).toBe(await h.balanceOf(van1Cash));
    for (const account of await h.models.account.find().lean().exec()) {
      const entries = (await h.models.entry.find({ accountId: account._id }).lean().exec()) as unknown as {
        debit: number;
        credit: number;
      }[];
      const net = Math.round(entries.reduce((sum, entry) => sum + entry.debit - entry.credit, 0) * 100) / 100;
      expect([account.code, account.balance]).toEqual([account.code, net]);
    }
  });

  it('updates when a receipt is cancelled, a handover rejected or an approved one cancelled', async () => {
    const { h1, h2, r5 } = await threeDays();
    await h.receipts.cancel(r5.id as string, { reason: 'Duplicate' }, office);
    expect(await rowOf(van1)).toMatchObject({ collectedCash: 1000, receiptCount: 4, unsettledClosing: 500 });

    await h.handovers.reject(h2.id as string, { reason: 'Recount' }, approver);
    expect(await rowOf(van1)).toMatchObject({ pendingApproval: 0, handoverCount: 1, unsettledClosing: 500 });

    await h.handovers.cancel(h1.id as string, { reason: 'Approved by mistake' }, office);
    expect(await rowOf(van1)).toMatchObject({ settled: 0, openShortage: 0, unsettledClosing: 1000, handoverCount: 0 });
  });

  it('leaves out staff who do not settle with the office', async () => {
    const accountant = await h.cashiers.create({ name: 'Accounts', staffType: StaffType.ACCOUNTANT }, office);
    await receipt(accountant, officeCash, 700, '2026-10-01');
    await receipt(van1, van1Cash, 100, '2026-10-01');

    const all = await report();
    expect(all.rows.map((row) => row.cashier.name)).toEqual(['Van 1']);
    expect(all.totals.collectedCash).toBe(100);
    expect((await report({ staffId: accountant.id as string })).rows).toEqual([]);
    await expect(h.collections.details(accountant.id as string, {}, office)).rejects.toThrow(/not found/);
  });

  it('filters by staff and location, and validates the range', async () => {
    await threeDays();
    expect((await report({ staffId: van2.id as string })).rows.map((row) => row.cashier.name)).toEqual(['Van 2']);
    expect((await report({ cashierId: van2.id as string })).rows.map((row) => row.cashier.name)).toEqual(['Van 2']);

    const route = await locationModel.create({ code: 'VAN-0001', name: 'Van 2 Route', type: LocationType.VAN });
    await h.cashiers.update(van2.id as string, { locationId: route.id as string }, office);
    expect((await report({ locationId: route.id as string })).rows).toMatchObject([
      { cashier: { name: 'Van 2', location: { name: 'Van 2 Route' } } },
    ]);
    await expect(report({ dateFrom: '2026-10-05', dateTo: '2026-10-01' })).rejects.toThrow(/dateFrom/);
  });

  it('details list the receipts (with settlement) and handovers behind a row', async () => {
    await threeDays();
    const details = await h.collections.details(van1.id as string, { dateFrom: '2026-10-01', dateTo: '2026-10-02' }, office);
    expect(details.receipts.map((r) => [r.amount, r.paymentMethod, r.settlementStatus, r.handover?.voucherNo ?? null])).toEqual([
      [500, 'cash', 'settled', 'CH-0001'],
      [200, 'bank', 'settled', 'CH-0001'],
      [400, 'cash', 'submitted', 'CH-0002'],
      [100, 'cash', 'unsettled', null],
    ]);
    expect(details.handovers).toMatchObject([
      { voucherNo: 'CH-0001', status: 'approved', expectedCash: 500, bankTotal: 200, receivedCash: 480, shortage: 20, receivedInto: { name: 'Office Cash' } },
      { voucherNo: 'CH-0002', status: 'submitted', expectedCash: 400, receivedCash: null, shortage: 0 },
    ]);
  });

  describe('access', () => {
    async function scopedSalesman(): Promise<AuthenticatedUser> {
      const user = await userModel.create({ email: 'r@ala.ae', passwordHash: 'x', name: 'Rashid', role: new Types.ObjectId() });
      await h.cashiers.update(van1.id as string, { linkedUserId: user.id as string }, office);
      return { ...makeUser('Rashid', [Permission.REPORTS_SALESMAN]), id: user.id as string, dataScope: DataScope.OWN };
    }

    it('gives a scoped user only their own row, and 404 on another staff member', async () => {
      await threeDays();
      h.harness.tokenUser = await scopedSalesman();
      const server = h.app.getHttpServer();

      const res = await request(server).get('/reports/salesman-collections');
      expect(res.status).toBe(200);
      expect(res.body.rows.map((row: { cashier: { name: string } }) => row.cashier.name)).toEqual(['Van 1']);
      expect((await request(server).get('/reports/salesman-collections').query({ staffId: van2.id })).body.rows).toEqual([]);
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
