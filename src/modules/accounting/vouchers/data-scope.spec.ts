import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { createVoucherHarness, makeUser, type VoucherHarness } from '../../../../test/voucher-test-module.js';
import { LedgerAccountType, type LedgerAccountDocument } from '../ledger-accounts/schemas/ledger-account.schema.js';
import type { CashierDocument } from '../../cashier/schemas/cashier.schema.js';
import { User, type UserDocument } from '../../users/schemas/user.schema.js';
import { DataScope, Permission, VAN_SALESMAN_PERMISSIONS } from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';

const { CASH, WALLET, PARTY } = LedgerAccountType;

describe('Data scope (own) on cash receipts', () => {
  let h: VoucherHarness;
  let userModel: Model<UserDocument>;
  const office = makeUser('Office');
  let salesman: AuthenticatedUser;
  let otherSalesman: AuthenticatedUser;
  let salesmanCashier: CashierDocument;
  let otherCashier: CashierDocument;
  let vanCash: LedgerAccountDocument;
  let officeCash: LedgerAccountDocument;
  let customer: LedgerAccountDocument;

  beforeAll(async () => {
    h = await createVoucherHarness('data_scope');
    userModel = h.moduleRef.get(getModelToken(User.name));
  }, 120_000);

  afterAll(async () => {
    await h?.app.close();
  });

  /** A Van Salesman: own scope, receipts read/create only, no balances:view. */
  async function scopedUser(name: string, allowedCashAccountIds: string[]): Promise<AuthenticatedUser> {
    const user = await userModel.create({
      email: `${name.toLowerCase()}@example.com`,
      passwordHash: 'x',
      name,
      role: new Types.ObjectId(),
    });
    return {
      ...makeUser(name, [...VAN_SALESMAN_PERMISSIONS]),
      id: user.id as string,
      dataScope: DataScope.OWN,
      allowedCashAccountIds,
    };
  }

  beforeEach(async () => {
    vanCash = await h.makeAccount('CASH-0001', CASH, 0, 'Van 1 Cash');
    officeCash = await h.makeAccount('CASH-0002', CASH, 0, 'Office Cash');
    customer = await h.makeAccount('CUS-0001', PARTY, 250, 'Ali Traders');
    salesman = await scopedUser('Rashid', [vanCash.id as string]);
    otherSalesman = await scopedUser('Yousef', [vanCash.id as string]);
    salesmanCashier = await h.cashiers.create({ name: 'Rashid', linkedUserId: salesman.id }, office);
    otherCashier = await h.cashiers.create({ name: 'Yousef', linkedUserId: otherSalesman.id }, office);
  });

  afterEach(async () => {
    h.harness.tokenUser = makeUser('Sachin');
    await h.reset();
    await userModel.deleteMany({}).exec();
  });

  const server = () => h.app.getHttpServer();
  const as = (user: AuthenticatedUser) => {
    h.harness.tokenUser = user;
  };
  const body = (extra: Record<string, unknown> = {}) => ({
    voucherDate: '2026-10-01',
    cashAccountId: vanCash.id,
    lines: [{ accountId: customer.id, amount: 100 }],
    ...extra,
  });
  /** Entered by the office (scope all) on the given cashier. */
  const officeReceipt = (cashier: CashierDocument) =>
    h.receipts.create(
      {
        voucherDate: '2026-10-01',
        cashAccountId: officeCash.id as string,
        cashierId: cashier.id as string,
        lines: [{ accountId: customer.id as string, amount: 40 }],
      },
      office,
    );

  it('creates on the linked cashier when none is sent, and keeps the creator from the token', async () => {
    as(salesman);
    const res = await request(server()).post('/cash-receipts').send(body());
    expect(res.status).toBe(201);
    expect(res.body.cashierId).toBe(salesmanCashier.id);
    expect(res.body.createdBy).toEqual({ id: salesman.id, name: 'Rashid' });
    // No balances:view: the line's old balance is left out.
    expect(res.body.lines[0]).not.toHaveProperty('oldBalance');

    const same = await request(server())
      .post('/cash-receipts')
      .send(body({ cashierId: salesmanCashier.id }));
    expect(same.status).toBe(201);
  });

  it('refuses another cashier or a cash account not assigned to the user (403), posting nothing', async () => {
    as(salesman);
    const otherCashierRes = await request(server())
      .post('/cash-receipts')
      .send(body({ cashierId: otherCashier.id }));
    expect(otherCashierRes.status).toBe(403);
    expect(otherCashierRes.body.message).toMatch(/your own cashier, CSH-0001 \(Rashid\)/);

    const otherAccount = await request(server())
      .post('/cash-receipts')
      .send(body({ cashAccountId: officeCash.id }));
    expect(otherAccount.status).toBe(403);
    expect(otherAccount.body.message).toMatch(/cash accounts assigned to you/);

    expect(await h.models.receipt.countDocuments().exec()).toBe(0);
    expect(await h.balanceOf(customer)).toBe(250);
  });

  it('gives a clear error to a scoped user with no linked cashier or no allowed accounts', async () => {
    const noCashier = await scopedUser('Hamad', [vanCash.id as string]);
    as(noCashier);
    const res = await request(server()).post('/cash-receipts').send(body());
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/not linked to a cashier/);

    const noAccounts = await scopedUser('Saeed', []);
    await h.cashiers.create({ name: 'Saeed', linkedUserId: noAccounts.id }, office);
    as(noAccounts);
    const res2 = await request(server()).post('/cash-receipts').send(body());
    expect(res2.status).toBe(403);
    expect(res2.body.message).toMatch(/No cash accounts are assigned to your user/);
  });

  it("returns 404 for another user's receipt on get, pdf, activity and comments, and leaves it out of the list", async () => {
    as(otherSalesman);
    const { body: theirs } = await request(server()).post('/cash-receipts').send(body());
    const officeForOther = await officeReceipt(otherCashier);

    as(salesman);
    for (const id of [theirs._id, officeForOther.id]) {
      expect((await request(server()).get(`/cash-receipts/${id}`)).status).toBe(404);
      expect((await request(server()).get(`/cash-receipts/${id}/pdf`)).status).toBe(404);
      const ref = { entityType: 'cash-receipt', entityId: id };
      expect((await request(server()).get('/activity').query(ref)).status).toBe(404);
      expect((await request(server()).get('/comments').query(ref)).status).toBe(404);
      expect((await request(server()).post('/comments').send({ ...ref, text: 'mine?' })).status).toBe(404);
    }
    const list = await request(server()).get('/cash-receipts');
    expect(list.body.summary).toEqual({ count: 0, total: 0 });
    // A filter can't widen the scope either.
    const filtered = await request(server()).get('/cash-receipts').query({ cashierId: otherCashier.id, q: 'CR' });
    expect(filtered.body.items).toEqual([]);
    // The print counter did not move.
    expect((await h.models.receipt.findById(theirs._id).lean().exec())!).toMatchObject({ printCount: 0 });
  });

  it('shows a receipt the office entered on his cashier, plus his own, and nothing else', async () => {
    const forHim = await officeReceipt(salesmanCashier);
    await officeReceipt(otherCashier);
    as(salesman);
    const { body: own } = await request(server()).post('/cash-receipts').send(body());

    const list = await request(server()).get('/cash-receipts');
    expect(list.status).toBe(200);
    const byId = (a: string, b: string) => a.localeCompare(b);
    expect(list.body.items.map((row: { id: string }) => row.id).sort(byId)).toEqual([forHim.id, own._id].sort(byId));
    expect(list.body.summary).toEqual({ count: 2, total: 140 });

    const one = await request(server()).get(`/cash-receipts/${forHim.id}`);
    expect(one.status).toBe(200);
    expect(one.body.lines[0]).not.toHaveProperty('oldBalance');
    expect((await request(server()).get(`/cash-receipts/${forHim.id}/pdf`)).status).toBe(200);
    const ref = { entityType: 'cash-receipt', entityId: forHim.id };
    expect((await request(server()).get('/activity').query(ref)).status).toBe(200);
    expect((await request(server()).post('/comments').send({ ...ref, text: 'Collected' })).status).toBe(201);
  });

  it('has no edit, cancel or payment access with the Van Salesman permissions', async () => {
    as(salesman);
    const { body: own } = await request(server()).post('/cash-receipts').send(body());
    expect((await request(server()).patch(`/cash-receipts/${own._id}`).send({ comments: 'x' })).status).toBe(403);
    expect((await request(server()).post(`/cash-receipts/${own._id}/cancel`).send({ reason: 'Oops' })).status).toBe(
      403,
    );
    expect((await request(server()).get('/cash-payments')).status).toBe(403);
  });

  it('keeps scope on edit and cancel when a scoped role is given those permissions', async () => {
    const editor: AuthenticatedUser = {
      ...salesman,
      permissions: [...salesman.permissions, Permission.CASH_RECEIPTS_EDIT, Permission.CASH_RECEIPTS_CANCEL],
    };
    const theirs = await officeReceipt(otherCashier);
    const mine = await officeReceipt(salesmanCashier);
    as(editor);
    expect((await request(server()).patch(`/cash-receipts/${theirs.id}`).send({ comments: 'x' })).status).toBe(404);
    expect((await request(server()).post(`/cash-receipts/${theirs.id}/cancel`).send({ reason: 'Nope' })).status).toBe(
      404,
    );
    // His own: editable, but not onto another cashier or an unassigned account.
    expect((await request(server()).patch(`/cash-receipts/${mine.id}`).send({ cashierId: otherCashier.id })).status).toBe(
      403,
    );
    const wallet = await h.makeAccount('WAL-0001', WALLET, 0, 'Van Wallet');
    expect((await request(server()).patch(`/cash-receipts/${mine.id}`).send({ cashAccountId: wallet.id })).status).toBe(
      403,
    );
    expect((await request(server()).patch(`/cash-receipts/${mine.id}`).send({ comments: 'Checked' })).status).toBe(200);
  });

  it('leaves unscoped users with balances:view seeing everything, balances included', async () => {
    as(otherSalesman);
    await request(server()).post('/cash-receipts').send(body());
    const accountant = makeUser('Accountant');
    expect(accountant.permissions).toContain(Permission.BALANCES_VIEW);
    as(accountant);
    const list = await request(server()).get('/cash-receipts');
    expect(list.body.summary.count).toBe(1);
    const one = await request(server()).get(`/cash-receipts/${list.body.items[0].id}`);
    expect(one.body.lines[0].oldBalance).toBe(250);
  });
});
