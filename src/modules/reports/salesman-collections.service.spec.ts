import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import { createVoucherHarness, makeUser, type VoucherHarness } from '../../../test/voucher-test-module.js';
import { LedgerAccountType, type LedgerAccountDocument } from '../accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { Location, type LocationDocument, LocationType } from '../location/schemas/location.schema.js';
import { ReportsController } from './reports.controller.js';
import { REQUIRE_PERMISSION_KEY } from '../../common/decorators/require-permission.decorator.js';
import { ACCOUNTANT_PERMISSIONS, DataScope, Permission, VAN_SALESMAN_PERMISSIONS } from '../roles/permissions.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';

const { CASH, CHEQUE, BANK, PARTY } = LedgerAccountType;

describe('Salesman collections report', () => {
  let h: VoucherHarness;
  let locationModel: Model<LocationDocument>;
  let office: AuthenticatedUser;
  let van1: AuthenticatedUser;
  let van2: AuthenticatedUser;
  let van1Cash: LedgerAccountDocument;
  let van1Cheques: LedgerAccountDocument;
  let van2Cash: LedgerAccountDocument;
  let officeCash: LedgerAccountDocument;
  let bank: LedgerAccountDocument;
  let customer: LedgerAccountDocument;

  beforeAll(async () => {
    h = await createVoucherHarness('salesman_collections');
    locationModel = h.moduleRef.get(getModelToken(Location.name));
  }, 120_000);

  afterAll(async () => {
    await h?.app.close();
  });

  beforeEach(async () => {
    van1Cash = await h.makeAccount('CASH-0001', CASH, 0, 'Van 1 Cash');
    van1Cheques = await h.makeAccount('CHQ-0001', CHEQUE, 0, 'Van 1 Cheques');
    van2Cash = await h.makeAccount('CASH-0002', CASH, 0, 'Van 2 Cash');
    officeCash = await h.makeAccount('CASH-0003', CASH, 0, 'Office Cash');
    bank = await h.makeAccount('BNK-0001', BANK, 0, 'ADCB');
    customer = await h.makeAccount('CUS-0001', PARTY, 0, 'Ali Traders');
    // Van 1 is an own-scoped salesman who may also read the report.
    van1 = await h.persistUser({
      ...makeUser('Van 1', [...VAN_SALESMAN_PERMISSIONS, Permission.REPORTS_SALESMAN]),
      dataScope: DataScope.OWN,
      allowedCashAccountIds: [van1Cash.id as string, van1Cheques.id as string],
    });
    van2 = await h.persistUser({
      ...makeUser('Van 2', [...VAN_SALESMAN_PERMISSIONS]),
      allowedCashAccountIds: [van2Cash.id as string],
    });
    office = await h.persistUser(makeUser('Office', [...ACCOUNTANT_PERMISSIONS]));
    await h.company.ensure();
    await h.models.company.updateOne({}, { defaultCashInHandAccountId: officeCash._id }).exec();
  });

  afterEach(async () => {
    h.harness.tokenUser = makeUser('Sachin');
    await h.reset();
    await locationModel.deleteMany({}).exec();
  });

  const receipt = (
    collector: AuthenticatedUser,
    into: LedgerAccountDocument,
    amount: number,
    date: string,
    chequeNumber?: string,
  ) =>
    h.receipts.create(
      {
        voucherDate: date,
        cashAccountId: into.id as string,
        collectedById: collector.id,
        ...(chequeNumber ? { chequeNumber, chequeBankName: 'ENBD', chequeDate: date } : {}),
        lines: [{ accountId: customer.id as string, amount }],
      },
      office,
    );

  const report = (query: Record<string, string> = {}) => h.collections.report(query, office);
  const rowOf = async (staff: AuthenticatedUser, query: Record<string, string> = {}) =>
    (await report(query)).rows.find((row) => row.staff.id === staff.id);

  /** Van 1: day 1 cash 500 + bank 200, day 2 cash 400 + cheque 100, day 3 cash 250. Van 2: 80 on day 2. */
  async function threeDays() {
    await receipt(van1, van1Cash, 500, '2026-10-01');
    await receipt(van1, bank, 200, '2026-10-01');
    await receipt(van1, van1Cash, 400, '2026-10-02');
    await receipt(van1, van1Cheques, 100, '2026-10-02', 'CHQ 77');
    const r5 = await receipt(van1, van1Cash, 250, '2026-10-03');
    await receipt(van2, van2Cash, 80, '2026-10-02');
    return { r5 };
  }

  it('splits receipts by how the money came in, day by day', async () => {
    await threeDays();
    expect(await rowOf(van1)).toMatchObject({
      receipts: 5,
      collectedCash: 1150,
      collectedCheque: 100,
      collectedBank: 200,
      total: 1450,
      withSalesman: 1250,
    });
    expect(await rowOf(van1, { dateFrom: '2026-10-02', dateTo: '2026-10-02' })).toMatchObject({
      receipts: 2,
      collectedCash: 400,
      collectedCheque: 100,
      collectedBank: 0,
      total: 500,
    });
    const all = await report({ dateFrom: '2026-10-02', dateTo: '2026-10-03' });
    expect(all.rows.map((row) => row.staff.name)).toEqual(['Van 1', 'Van 2']);
    expect(all.totals).toMatchObject({ receipts: 4, collectedCash: 730, collectedCheque: 100, total: 830 });
  });

  it('shows handed over (approved in range), pending approval and what is still with the salesman', async () => {
    await threeDays();
    const first = await h.handovers.create(
      {
        lines: [
          { sourceAccountId: van1Cash.id as string, amount: 900 },
          { sourceAccountId: van1Cheques.id as string, amount: 100 },
        ],
      },
      van1,
    );
    expect(await rowOf(van1)).toMatchObject({ handedOver: 0, pendingApproval: 1000, withSalesman: 1250 });

    await h.handovers.approve(
      first._id.toString(),
      {
        lines: [
          { sourceAccountId: van1Cash.id as string, receivedAmount: 880 },
          { sourceAccountId: van1Cheques.id as string, receivedIntoAccountId: bank.id as string },
        ],
        reason: 'Short 20',
      },
      office,
    );
    const row = (await rowOf(van1))!;
    expect(row).toMatchObject({ handedOver: 980, pendingApproval: 0, withSalesman: 270 });
    expect(row.withSalesman).toBe((await h.balanceOf(van1Cash)) + (await h.balanceOf(van1Cheques)));
    // Approved today, so nothing handed over in an old range; the holding is still shown.
    expect(await rowOf(van1, { dateFrom: '2020-01-01', dateTo: '2020-01-02' })).toMatchObject({
      receipts: 0,
      handedOver: 0,
      withSalesman: 270,
    });
  });

  it('totals match the receipts list for the same filters; numbers are never null', async () => {
    const { r5 } = await threeDays();
    await h.receipts.cancel(r5.id as string, { reason: 'Duplicate' }, office);
    for (const [user, dateFrom, dateTo] of [
      [van1, '2026-10-01', '2026-10-03'],
      [van1, '2026-10-02', '2026-10-02'],
      [van2, '2026-10-01', '2026-10-03'],
    ] as const) {
      const row = (await rowOf(user, { userId: user.id, dateFrom, dateTo }))!;
      const list = await h.receipts.findAll({ dateFrom, dateTo, collectedBy: user.id, status: 'posted' }, office);
      expect([row.receipts, row.total]).toEqual([list.summary.count, list.summary.total]);
    }
    const { staff: _staff, ...idle } = (await report({ userId: office.id })).rows[0];
    expect(Object.values(idle)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('filters by user and location, and validates the range', async () => {
    await threeDays();
    expect((await report({ userId: van2.id })).rows.map((row) => row.staff.name)).toEqual(['Van 2']);

    const route = await locationModel.create({ code: 'VAN-0001', name: 'Van 2 Route', type: LocationType.VAN });
    await h.models.user.updateOne({ _id: van2.id }, { locationId: route._id }).exec();
    expect((await report({ locationId: route.id as string })).rows).toMatchObject([
      { staff: { id: van2.id, name: 'Van 2', status: 'active', location: { id: route.id, name: 'Van 2 Route' } } },
    ]);
    await expect(report({ dateFrom: '2026-10-05', dateTo: '2026-10-01' })).rejects.toThrow(/dateFrom/);
  });

  it('details list the receipts and handovers behind a row, always as arrays', async () => {
    await threeDays();
    await h.handovers.create({ voucherDate: '2026-10-04', lines: [{ sourceAccountId: van1Cash.id as string, amount: 100 }] }, van1);
    const details = await h.collections.details(van1.id, { dateFrom: '2026-10-01', dateTo: '2026-10-02' }, office);
    expect(details.receipts.map((r) => [r.amount, r.paymentMethod, r.chequeNumber])).toEqual([
      [500, 'cash', null],
      [200, 'bank', null],
      [400, 'cash', null],
      [100, 'cheque', 'CHQ 77'],
    ]);
    expect(details.handovers).toEqual([]);
    expect((await h.collections.details(van1.id, {}, office)).handovers).toMatchObject([
      { voucherNo: 'HO-0001', status: 'submitted', submittedTotal: 100, receivedTotal: null },
    ]);
    expect(await h.collections.details(office.id, {}, office)).toMatchObject({ receipts: [], handovers: [] });
  });

  describe('access', () => {
    it('gives a scoped user only their own row, and 404 on another user', async () => {
      await threeDays();
      h.harness.tokenUser = van1;
      const server = h.app.getHttpServer();

      const res = await request(server).get('/reports/salesman-collections');
      expect(res.status).toBe(200);
      expect(res.body.rows.map((row: { staff: { name: string } }) => row.staff.name)).toEqual(['Van 1']);
      expect((await request(server).get('/reports/salesman-collections').query({ userId: van2.id })).body.rows).toEqual([]);
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
