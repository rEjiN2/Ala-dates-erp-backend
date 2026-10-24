import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createVoucherHarness, makeUser, type VoucherHarness } from '../../../../test/voucher-test-module.js';
import { LedgerAccountType } from '../ledger-accounts/schemas/ledger-account.schema.js';
import { OPENING_BALANCE_EQUITY_KEY } from './schemas/opening-balance.schema.js';
import { ACCOUNTANT_PERMISSIONS, Permission } from '../../roles/permissions.js';

const { CASH, CHEQUE, PARTY, SUPPLIER } = LedgerAccountType;

describe('OpeningBalanceService', () => {
  let h: VoucherHarness;
  const sachin = makeUser('Sachin');

  beforeAll(async () => {
    h = await createVoucherHarness('opening_balances');
  }, 120_000);

  afterAll(async () => {
    await h?.app.close();
  });

  beforeEach(async () => {
    await h.persistUser(sachin);
  });

  afterEach(async () => {
    h.harness.tokenUser = sachin;
    await h.reset();
  });

  async function accounts() {
    return {
      cash: await h.makeAccount('CASH-0001', CASH, 0, 'Main Cash'),
      customer: await h.makeAccount('CUS-0001', PARTY, 0, 'Ali Traders'),
      supplier: await h.makeAccount('SUP-0001', SUPPLIER, 0, 'Omar Farms'),
      cheques: await h.makeAccount('CHQ-0001', CHEQUE, 0, 'Cheques in Hand'),
    };
  }

  const equity = async () => (await h.models.account.findOne({ systemKey: OPENING_BALANCE_EQUITY_KEY }).exec())!;

  /** Every account's balance equals the sum of its ledger entries. */
  async function expectBalancesMatchLedger() {
    const sums = await h.models.entry
      .aggregate<{ _id: unknown; net: number }>([
        { $group: { _id: '$accountId', net: { $sum: { $subtract: ['$debit', '$credit'] } } } },
      ])
      .exec();
    const net = new Map(sums.map((row) => [String(row._id), Math.round(row.net * 100) / 100]));
    for (const account of await h.models.account.find().exec()) {
      expect(account.balance).toBe(net.get(account.id) ?? 0);
    }
  }

  it('posts a customer debit and a supplier credit, with Equity absorbing the difference', async () => {
    const { customer, supplier } = await accounts();
    const ob = await h.openingBalances.create(
      {
        asOfDate: '2026-01-01',
        lines: [
          { accountId: customer.id, debit: 1000 },
          { accountId: supplier.id, credit: 300 },
        ],
      },
      sachin,
    );

    expect(ob.voucherNo).toBe('OB-0001');
    expect(ob).toMatchObject({ totalDebit: 1000, totalCredit: 300, equityDebit: 0, equityCredit: 700 });
    expect(await h.balanceOf(customer)).toBe(1000);
    expect(await h.balanceOf(supplier)).toBe(-300);
    const eq = await equity();
    expect(eq.balance).toBe(-700);
    expect(eq.isSystemManaged).toBe(true);
    expect(await h.models.entry.countDocuments({ voucherId: ob._id })).toBe(3);
    await expectBalancesMatchLedger();
  });

  it('rejects a second voucher for the same account, naming the existing one', async () => {
    const { customer, cash } = await accounts();
    await h.openingBalances.create({ asOfDate: '2026-01-01', lines: [{ accountId: customer.id, debit: 50 }] }, sachin);

    await expect(
      h.openingBalances.create(
        {
          asOfDate: '2026-01-01',
          lines: [
            { accountId: cash.id, debit: 10 },
            { accountId: customer.id, debit: 20 },
          ],
        },
        sachin,
      ),
    ).rejects.toThrow('Line 2: CUS-0001 (Ali Traders) already has an opening balance on OB-0001');
    expect(await h.balanceOf(cash)).toBe(0);
  });

  it('rejects cheque accounts, both sides filled, future dates and equity itself', async () => {
    const { cheques, cash } = await accounts();
    await expect(
      h.openingBalances.create({ asOfDate: '2026-01-01', lines: [{ accountId: cheques.id, debit: 10 }] }, sachin),
    ).rejects.toThrow('enter pending cheques as cheque receipts');
    await expect(
      h.openingBalances.create(
        { asOfDate: '2026-01-01', lines: [{ accountId: cash.id, debit: 10, credit: 5 }] },
        sachin,
      ),
    ).rejects.toThrow('Enter either a debit or a credit, not both');
    await expect(
      h.openingBalances.create({ asOfDate: '2999-01-01', lines: [{ accountId: cash.id, debit: 10 }] }, sachin),
    ).rejects.toThrow('cannot be in the future');

    await h.openingBalances.create({ asOfDate: '2026-01-01', lines: [{ accountId: cash.id, debit: 10 }] }, sachin);
    const eq = await equity();
    await expect(
      h.openingBalances.create({ asOfDate: '2026-01-01', lines: [{ accountId: eq.id, debit: 10 }] }, sachin),
    ).rejects.toThrow('system account');
    // Not offered in voucher pickers, not usable on a voucher line, not editable.
    expect((await h.ledger.lookup({ limit: 50 })).some((a) => a.id === eq.id)).toBe(false);
    await expect(
      h.payments.create(
        { voucherDate: '2026-02-01', paidFromAccountId: cash.id, lines: [{ accountId: eq.id, amount: 1 }] },
        sachin,
      ),
    ).rejects.toThrow('system account');
    await expect(h.ledger.update(eq.id, { name: 'X' })).rejects.toThrow('system account');
  });

  it('cancel restores balances; the account can then be opened again', async () => {
    const { customer, supplier } = await accounts();
    const ob = await h.openingBalances.create(
      {
        asOfDate: '2026-01-01',
        lines: [
          { accountId: customer.id, debit: 1000 },
          { accountId: supplier.id, credit: 300 },
        ],
      },
      sachin,
    );
    const cancelled = await h.openingBalances.cancel(ob.id, { reason: 'Wrong figures' }, sachin);

    expect(cancelled.status).toBe('cancelled');
    expect(await h.balanceOf(customer)).toBe(0);
    expect(await h.balanceOf(supplier)).toBe(0);
    expect((await equity()).balance).toBe(0);
    await expectBalancesMatchLedger();
    await expect(h.openingBalances.cancel(ob.id, { reason: 'Again' }, sachin)).rejects.toThrow('is cancelled');

    const again = await h.openingBalances.create(
      { asOfDate: '2026-01-01', lines: [{ accountId: customer.id, debit: 200 }] },
      sachin,
    );
    expect(again.voucherNo).toBe('OB-0002');
    expect(await h.balanceOf(customer)).toBe(200);
  });

  it('edit reverses and reposts, audits a field diff, and rejects a no-change edit', async () => {
    const { customer, supplier } = await accounts();
    const ob = await h.openingBalances.create(
      { asOfDate: '2026-01-01', lines: [{ accountId: customer.id, debit: 1000 }] },
      sachin,
    );
    await h.openingBalances.update(
      ob.id,
      {
        lines: [
          { accountId: customer.id, debit: 400 },
          { accountId: supplier.id, credit: 900 },
        ],
      },
      sachin,
    );

    expect(await h.balanceOf(customer)).toBe(400);
    expect(await h.balanceOf(supplier)).toBe(-900);
    expect((await equity()).balance).toBe(500);
    await expectBalancesMatchLedger();
    const audit = await h.models.audit.findOne({ entityId: ob._id, action: 'updated' }).lean().exec();
    expect((audit as unknown as { changes: unknown[] }).changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Ali Traders', from: 'Dr 1000.00', to: 'Dr 400.00' }),
        expect.objectContaining({ label: 'Omar Farms', from: null, to: 'Cr 900.00' }),
      ]),
    );
    await expect(
      h.openingBalances.update(ob.id, { comments: undefined, asOfDate: '2026-01-01' }, sachin),
    ).rejects.toThrow('No changes to save');
  });

  it('validate resolves codes and reports row errors without posting', async () => {
    const { cash, customer } = await accounts();
    await h.openingBalances.create({ asOfDate: '2026-01-01', lines: [{ accountId: customer.id, debit: 5 }] }, sachin);

    const result = await h.openingBalances.validate({
      lines: [
        { accountCode: 'cash-0001', debit: 100 },
        { accountCode: 'NOPE-1', debit: 1 },
        { accountCode: 'CHQ-0001', debit: 1 },
        { accountCode: 'CASH-0001', debit: 1, credit: 1 },
        { accountCode: 'CUS-0001', credit: 2 },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.lines[0]).toMatchObject({ row: 1, accountId: cash.id, accountName: 'Main Cash', debit: 100 });
    const messages = result.errors.map((e) => `${e.row}: ${e.message}`);
    expect(messages).toEqual([
      '2: Unknown account code "NOPE-1"',
      '3: CHQ-0001 (Cheques in Hand) is a cheque account: enter pending cheques as cheque receipts',
      '4: CASH-0001 (Main Cash) is on more than one line',
      '4: Enter either a debit or a credit, not both',
      '5: CUS-0001 (Ali Traders) already has an opening balance on OB-0001',
    ]);
    expect(await h.balanceOf(cash)).toBe(0);
  });

  it('routes need opening-balances permissions; the Accountant role only reads', async () => {
    expect(ACCOUNTANT_PERMISSIONS).toContain(Permission.OPENING_BALANCES_READ);
    expect(ACCOUNTANT_PERMISSIONS).not.toContain(Permission.OPENING_BALANCES_CREATE);
    expect(ACCOUNTANT_PERMISSIONS).not.toContain(Permission.OPENING_BALANCES_EDIT);
    expect(ACCOUNTANT_PERMISSIONS).not.toContain(Permission.OPENING_BALANCES_CANCEL);

    const { cash } = await accounts();
    h.harness.tokenUser = makeUser('Accountant', [...ACCOUNTANT_PERMISSIONS]);
    const server = h.app.getHttpServer();
    await request(server)
      .post('/opening-balances')
      .send({ asOfDate: '2026-01-01', lines: [{ accountId: cash.id, debit: 1 }] })
      .expect(403);
    await request(server).post('/opening-balances/validate').send({ lines: [{ accountCode: 'CASH-0001', debit: 1 }] }).expect(403);
    const list = await request(server).get('/opening-balances?status=posted').expect(200);
    expect(list.body.summary.count).toBe(0);
  });
});
