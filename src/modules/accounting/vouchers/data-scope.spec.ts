import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import request from 'supertest';
import {
  createVoucherHarness,
  makeUser,
  type VoucherHarness,
} from '../../../../test/voucher-test-module.js';
import {
  LedgerAccountType,
  type LedgerAccountDocument,
} from '../ledger-accounts/schemas/ledger-account.schema.js';
import {
  ACCOUNTANT_PERMISSIONS,
  DataScope,
  Permission,
  VAN_SALESMAN_PERMISSIONS,
} from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import {
  assertScopedHeaderAccount,
  resolveCollectorId,
  voucherScopeFilter,
} from './data-scope.js';
import { VoucherScopeRule } from './voucher-definition.js';

const { CASH, WALLET, PARTY } = LedgerAccountType;

describe('data-scope helpers', () => {
  const me = new Types.ObjectId().toString();
  const own = {
    id: me,
    name: 'Rashid',
    dataScope: DataScope.OWN,
    allowedCashAccountIds: ['a1'],
    permissions: [],
  };

  it('voucherScopeFilter: null for scope all, creator-or-collector by default', () => {
    expect(voucherScopeFilter(undefined)).toBeNull();
    expect(voucherScopeFilter({ ...own, dataScope: DataScope.ALL })).toBeNull();
    expect(voucherScopeFilter({ id: me, name: 'Bare' })).toBeNull();
    const meId = new Types.ObjectId(me);
    expect(voucherScopeFilter(own)).toEqual({
      $or: [{ 'createdBy.id': meId }, { collectedById: meId }],
    });
    expect(
      voucherScopeFilter(own, VoucherScopeRule.CREATOR_OR_COLLECTOR),
    ).toEqual(voucherScopeFilter(own));
  });

  it('resolveCollectorId: defaults to me; anyone else needs vouchers:select-collector', () => {
    const other = new Types.ObjectId().toString();
    expect(resolveCollectorId(own, undefined)).toBe(me);
    expect(resolveCollectorId(own, null)).toBe(me);
    expect(resolveCollectorId(own, me)).toBe(me);
    expect(() => resolveCollectorId(own, other)).toThrow(
      new ForbiddenException(
        'You can only record vouchers collected by yourself.',
      ),
    );
    expect(
      resolveCollectorId(
        { ...own, permissions: [Permission.VOUCHERS_SELECT_COLLECTOR] },
        other,
      ),
    ).toBe(other);
  });

  it('assertScopedHeaderAccount: only an assigned account, with a clear error when none is assigned', () => {
    expect(() =>
      assertScopedHeaderAccount(own, 'a1', 'Cash receipt'),
    ).not.toThrow();
    expect(() => assertScopedHeaderAccount(own, 'a2', 'Cash receipt')).toThrow(
      /cash accounts assigned to you/,
    );
    expect(() =>
      assertScopedHeaderAccount(
        { ...own, allowedCashAccountIds: [] },
        'a1',
        'Cash receipt',
      ),
    ).toThrow(
      /No cash accounts are assigned to your user, so you cannot enter a cash receipt/,
    );
  });
});

describe('Data scope (own) on cash receipts', () => {
  let h: VoucherHarness;
  let office: AuthenticatedUser;
  let accountant: AuthenticatedUser;
  let salesman: AuthenticatedUser;
  let otherSalesman: AuthenticatedUser;
  let vanCash: LedgerAccountDocument;
  let officeCash: LedgerAccountDocument;
  let customer: LedgerAccountDocument;

  beforeAll(async () => {
    h = await createVoucherHarness('data_scope');
  }, 120_000);

  afterAll(async () => {
    await h?.app.close();
  });

  /** A Van Salesman: own scope, receipts read/create only, no select-collector, no balances:view. */
  const scopedUser = (name: string, allowedCashAccountIds: string[]) =>
    h.persistUser(
      {
        ...makeUser(name, [...VAN_SALESMAN_PERMISSIONS]),
        dataScope: DataScope.OWN,
        allowedCashAccountIds,
      },
      { settlesWithOffice: true },
    );

  beforeEach(async () => {
    vanCash = await h.makeAccount('CASH-0001', CASH, 0, 'Van 1 Cash');
    officeCash = await h.makeAccount('CASH-0002', CASH, 0, 'Office Cash');
    customer = await h.makeAccount('CUS-0001', PARTY, 250, 'Ali Traders');
    office = await h.persistUser(makeUser('Office'));
    accountant = await h.persistUser(
      makeUser('Mona', [...ACCOUNTANT_PERMISSIONS]),
    );
    salesman = await scopedUser('Rashid', [vanCash.id as string]);
    otherSalesman = await scopedUser('Yousef', [vanCash.id as string]);
  });

  afterEach(async () => {
    h.harness.tokenUser = makeUser('Sachin');
    await h.reset();
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
  /** Entered by the office (scope all) and collected by the given user. */
  const officeReceipt = (collector: AuthenticatedUser) =>
    h.receipts.create(
      {
        voucherDate: '2026-10-01',
        cashAccountId: officeCash.id as string,
        collectedById: collector.id,
        lines: [{ accountId: customer.id as string, amount: 40 }],
      },
      office,
    );

  it('collects as the caller when none is sent, keeps the creator from the token and strips old balances', async () => {
    expect(accountant.permissions).toContain(
      Permission.VOUCHERS_SELECT_COLLECTOR,
    );
    expect(salesman.permissions).not.toContain(
      Permission.VOUCHERS_SELECT_COLLECTOR,
    );
    expect(salesman.permissions).not.toContain(Permission.BALANCES_VIEW);

    as(salesman);
    const res = await request(server()).post('/cash-receipts').send(body());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      collectedById: salesman.id,
      collectedByName: 'Rashid',
    });
    expect(res.body.createdBy).toEqual({ id: salesman.id, name: 'Rashid' });
    // No balances:view: the line's old balance is left out.
    expect(res.body.lines[0]).not.toHaveProperty('oldBalance');

    const same = await request(server())
      .post('/cash-receipts')
      .send(body({ collectedById: salesman.id }));
    expect(same.status).toBe(201);
  });

  it('refuses another collector or a cash account not assigned to the user (403), posting nothing', async () => {
    as(salesman);
    const otherCollector = await request(server())
      .post('/cash-receipts')
      .send(body({ collectedById: otherSalesman.id }));
    expect(otherCollector.status).toBe(403);
    expect(otherCollector.body.message).toBe(
      'You can only record vouchers collected by yourself.',
    );

    const otherAccount = await request(server())
      .post('/cash-receipts')
      .send(body({ cashAccountId: officeCash.id }));
    expect(otherAccount.status).toBe(403);
    expect(otherAccount.body.message).toMatch(/cash accounts assigned to you/);

    expect(await h.models.receipt.countDocuments().exec()).toBe(0);
    expect(await h.balanceOf(customer)).toBe(250);
  });

  it('gives a clear error to a scoped user with no allowed accounts', async () => {
    const noAccounts = await scopedUser('Saeed', []);
    as(noAccounts);
    const res = await request(server()).post('/cash-receipts').send(body());
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(
      /No cash accounts are assigned to your user/,
    );
  });

  it("returns 404 for another user's receipt on get, pdf, activity and comments, and leaves it out of the list", async () => {
    as(otherSalesman);
    const { body: theirs } = await request(server())
      .post('/cash-receipts')
      .send(body());
    const officeForOther = await officeReceipt(otherSalesman);

    as(salesman);
    for (const id of [theirs._id, officeForOther.id]) {
      expect((await request(server()).get(`/cash-receipts/${id}`)).status).toBe(
        404,
      );
      expect(
        (await request(server()).get(`/cash-receipts/${id}/pdf`)).status,
      ).toBe(404);
      const ref = { entityType: 'cash-receipt', entityId: id };
      expect((await request(server()).get('/activity').query(ref)).status).toBe(
        404,
      );
      expect((await request(server()).get('/comments').query(ref)).status).toBe(
        404,
      );
      expect(
        (
          await request(server())
            .post('/comments')
            .send({ ...ref, text: 'mine?' })
        ).status,
      ).toBe(404);
    }
    const list = await request(server()).get('/cash-receipts');
    expect(list.body.summary).toEqual({ count: 0, total: 0 });
    // A filter can't widen the scope either.
    const filtered = await request(server())
      .get('/cash-receipts')
      .query({ collectedBy: otherSalesman.id, q: 'CR' });
    expect(filtered.body.items).toEqual([]);
    // The print counter did not move.
    expect(
      (await h.models.receipt.findById(theirs._id).lean().exec())!,
    ).toMatchObject({ printCount: 0 });
  });

  it('lets an accountant record a receipt collected by the salesman, which the salesman then sees', async () => {
    as(accountant);
    const created = await request(server())
      .post('/cash-receipts')
      .send(
        body({
          cashAccountId: officeCash.id,
          collectedById: salesman.id,
          lines: [{ accountId: customer.id, amount: 40 }],
        }),
      );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      collectedById: salesman.id,
      collectedByName: 'Rashid',
    });
    expect(created.body.createdBy).toEqual({ id: accountant.id, name: 'Mona' });
    const forHim = created.body._id as string;
    await officeReceipt(otherSalesman);

    as(salesman);
    const { body: own } = await request(server())
      .post('/cash-receipts')
      .send(body());

    const list = await request(server()).get('/cash-receipts');
    expect(list.status).toBe(200);
    const byId = (a: string, b: string) => a.localeCompare(b);
    expect(
      list.body.items.map((row: { id: string }) => row.id).sort(byId),
    ).toEqual([forHim, own._id].sort(byId));
    expect(list.body.summary).toEqual({ count: 2, total: 140 });
    const row = list.body.items.find(
      (item: { id: string }) => item.id === forHim,
    );
    expect(row.collectedBy).toEqual({ id: salesman.id, name: 'Rashid' });

    const one = await request(server()).get(`/cash-receipts/${forHim}`);
    expect(one.status).toBe(200);
    expect(one.body.lines[0]).not.toHaveProperty('oldBalance');
    expect(
      (await request(server()).get(`/cash-receipts/${forHim}/pdf`)).status,
    ).toBe(200);
    const ref = { entityType: 'cash-receipt', entityId: forHim };
    expect((await request(server()).get('/activity').query(ref)).status).toBe(
      200,
    );
    expect(
      (
        await request(server())
          .post('/comments')
          .send({ ...ref, text: 'Collected' })
      ).status,
    ).toBe(201);
  });

  it('has no edit, cancel or payment access with the Van Salesman permissions', async () => {
    as(salesman);
    const { body: own } = await request(server())
      .post('/cash-receipts')
      .send(body());
    expect(
      (
        await request(server())
          .patch(`/cash-receipts/${own._id}`)
          .send({ comments: 'x' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(server())
          .post(`/cash-receipts/${own._id}/cancel`)
          .send({ reason: 'Oops' })
      ).status,
    ).toBe(403);
    expect((await request(server()).get('/cash-payments')).status).toBe(403);
  });

  it('keeps scope on edit and cancel when a scoped role is given those permissions', async () => {
    const editor: AuthenticatedUser = {
      ...salesman,
      permissions: [
        ...salesman.permissions,
        Permission.CASH_RECEIPTS_EDIT,
        Permission.CASH_RECEIPTS_CANCEL,
      ],
    };
    const theirs = await officeReceipt(otherSalesman);
    const mine = await officeReceipt(salesman);
    as(editor);
    expect(
      (
        await request(server())
          .patch(`/cash-receipts/${theirs.id}`)
          .send({ comments: 'x' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(server())
          .post(`/cash-receipts/${theirs.id}/cancel`)
          .send({ reason: 'Nope' })
      ).status,
    ).toBe(404);
    // His own: editable, but not onto another collector or an unassigned account.
    expect(
      (
        await request(server())
          .patch(`/cash-receipts/${mine.id}`)
          .send({ collectedById: otherSalesman.id })
      ).status,
    ).toBe(403);
    const wallet = await h.makeAccount('WAL-0001', WALLET, 0, 'Van Wallet');
    expect(
      (
        await request(server())
          .patch(`/cash-receipts/${mine.id}`)
          .send({ cashAccountId: wallet.id })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(server())
          .patch(`/cash-receipts/${mine.id}`)
          .send({ comments: 'Checked' })
      ).status,
    ).toBe(200);
  });

  it('leaves unscoped users with balances:view seeing everything, balances included', async () => {
    as(otherSalesman);
    await request(server()).post('/cash-receipts').send(body());
    expect(accountant.permissions).toContain(Permission.BALANCES_VIEW);
    as(accountant);
    const list = await request(server()).get('/cash-receipts');
    expect(list.body.summary.count).toBe(1);
    const one = await request(server()).get(
      `/cash-receipts/${list.body.items[0].id}`,
    );
    expect(one.body.lines[0].oldBalance).toBe(250);
  });
});
