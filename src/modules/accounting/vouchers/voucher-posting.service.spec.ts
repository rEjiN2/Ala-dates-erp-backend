import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { createVoucherHarness, makeUser, type VoucherHarness } from '../../../../test/voucher-test-module.js';
import { LedgerAccountType } from '../ledger-accounts/schemas/ledger-account.schema.js';
import type { LedgerAccountDocument } from '../ledger-accounts/schemas/ledger-account.schema.js';
import { InsertOnlyViolationError } from '../../../common/utils/insert-only.plugin.js';
import { round2 } from '../../../common/utils/money.util.js';

const { CASH, WALLET, BANK, PARTY, SUPPLIER, INCOME, EXPENSE, OTHER } = LedgerAccountType;

/** The engine behind both Cash Receipt and Cash Payment, exercised through both. */
describe('VoucherPostingService (shared by receipts and payments)', () => {
  let h: VoucherHarness;
  const user = makeUser('Sachin');

  beforeAll(async () => {
    h = await createVoucherHarness('voucher_posting');
  }, 120_000);

  afterAll(async () => {
    await h?.app.close();
  });

  afterEach(async () => {
    await h.reset();
  });

  async function setup() {
    const cashier = await h.cashiers.create({ name: 'Sachin' }, user);
    const a = {
      cash: await h.makeAccount('CASH-0001', CASH, 0, 'Main Cash'),
      wallet: await h.makeAccount('WAL-0001', WALLET, 0, 'STC Pay'),
      bank: await h.makeAccount('BNK-0001', BANK, 0, 'ADCB'),
      ali: await h.makeAccount('CUS-0001', PARTY, 0, 'Ali Traders'),
      zaid: await h.makeAccount('CUS-0002', PARTY, 0, 'Zaid Foods'),
      farms: await h.makeAccount('SUP-0001', SUPPLIER, 0, 'Omar Farms'),
      rent: await h.makeAccount('EXP-0001', EXPENSE, 0, 'Rent'),
      scrap: await h.makeAccount('INC-0001', INCOME, 0, 'Scrap Sales'),
      suspense: await h.makeAccount('OTH-0001', OTHER, 0, 'Suspense'),
    };
    const line = (account: LedgerAccountDocument, amount: number, vat = 0) => ({ accountId: account.id, amount, vat });
    const receive = (into: LedgerAccountDocument, lines: ReturnType<typeof line>[], date = '2026-10-01') =>
      h.receipts.create({ voucherDate: date, cashAccountId: into.id, cashierId: cashier.id, lines }, user);
    const pay = (from: LedgerAccountDocument, lines: ReturnType<typeof line>[], acknowledgeWarnings = true) =>
      h.payments.create(
        { voucherDate: '2026-10-02', paidFromAccountId: from.id, cashierId: cashier.id, lines, acknowledgeWarnings },
        user,
      );
    return { a, line, receive, pay };
  }

  type Entry = {
    accountId: Types.ObjectId;
    debit: number;
    credit: number;
    voucherType: string;
    voucherId: Types.ObjectId;
  };
  const allEntries = async () => (await h.models.entry.find().lean().exec()) as unknown as Entry[];

  async function assertReconciled(accounts: LedgerAccountDocument[]) {
    const entries = await allEntries();
    for (const account of accounts) {
      const fromEntries = round2(
        entries
          .filter((entry) => entry.accountId.equals(account._id))
          .reduce((sum, entry) => sum + entry.debit - entry.credit, 0),
      );
      expect([account.code, await h.balanceOf(account)]).toEqual([account.code, fromEntries]);
    }
    // Double entry: every voucher's rows balance, so the whole ledger does too.
    expect(round2(entries.reduce((sum, e) => sum + e.debit, 0))).toBe(
      round2(entries.reduce((sum, e) => sum + e.credit, 0)),
    );
  }

  it('reconciles: every balance equals the sum of its ledger entries after receipts, payments, edits and cancels', async () => {
    const { a, line, receive, pay } = await setup();

    const r1 = await receive(a.cash, [line(a.ali, 300)]);
    const r2 = await receive(a.bank, [line(a.zaid, 200, 10), line(a.scrap, 50)]);
    const r3 = await receive(a.wallet, [line(a.ali, 40)]);
    const p1 = await pay(a.cash, [line(a.farms, 120)]);
    const p2 = await pay(a.bank, [line(a.rent, 75.5, 3.78), line(a.suspense, 0.01)]);
    const p3 = await pay(a.wallet, [line(a.suspense, 10)]);

    // Edits: amounts, a moved header account, a date-only change and a new line.
    await h.receipts.update(r1.id, { cashAccountId: a.bank.id, lines: [line(a.ali, 350), line(a.suspense, 20)] }, user);
    await h.payments.update(p1.id, { paidFromAccountId: a.wallet.id, acknowledgeWarnings: true }, user);
    await h.payments.update(p2.id, { lines: [line(a.rent, 80, 4)] }, user);
    await h.receipts.update(r2.id, { voucherDate: '2026-10-05' }, user);
    // Cancels, and a hard-deleted receipt.
    await h.receipts.cancel(r3.id, { reason: 'Duplicate' }, user);
    await h.payments.cancel(p3.id, { reason: 'Duplicate' }, user);
    await h.receipts.remove(r2.id);

    await assertReconciled(Object.values(a));

    // And the balances are the ones the surviving vouchers imply.
    expect(await h.balanceOf(a.bank)).toBe(370 - 84); // r1 moved to bank (350 + 20), p2 84; r2 deleted
    expect(await h.balanceOf(a.wallet)).toBe(-120); // p1 moved to wallet; r3 and p3 cancelled
    expect(await h.balanceOf(a.cash)).toBe(0);
    expect(await h.balanceOf(a.ali)).toBe(-350);
    expect(await h.balanceOf(a.farms)).toBe(120);
    expect(await h.balanceOf(a.rent)).toBe(84);
    expect(await h.balanceOf(a.zaid)).toBe(0);
    expect(await h.balanceOf(a.suspense)).toBe(-20);
  });

  it('nets a cancelled voucher to zero on every account it touched', async () => {
    const { a, line, receive, pay } = await setup();
    const receipt = await receive(a.cash, [line(a.ali, 99.99, 5)]);
    const payment = await pay(a.bank, [line(a.rent, 10)]);
    await h.receipts.cancel(receipt.id, { reason: 'Mistake' }, user);
    await h.payments.cancel(payment.id, { reason: 'Mistake' }, user);

    for (const voucher of [receipt, payment]) {
      const rows = (await allEntries()).filter((entry) => entry.voucherId.equals(voucher._id));
      const net = new Map<string, number>();
      for (const row of rows)
        net.set(row.accountId.toString(), round2((net.get(row.accountId.toString()) ?? 0) + row.debit - row.credit));
      expect([...net.values()].every((value) => value === 0)).toBe(true);
    }
    await assertReconciled(Object.values(a));
  });

  it('posts receipts and payments on opposite sides of the same accounts', async () => {
    const { a, line, receive, pay } = await setup();
    const receipt = await receive(a.cash, [line(a.ali, 100)]);
    const payment = await pay(a.cash, [line(a.ali, 100)], false);
    const sides = async (voucherId: Types.ObjectId) =>
      (await allEntries())
        .filter((entry) => entry.voucherId.equals(voucherId))
        .map((entry) => [entry.accountId.toString(), entry.debit, entry.credit]);

    expect(await sides(receipt._id)).toEqual([
      [a.cash.id, 100, 0],
      [a.ali.id, 0, 100],
    ]);
    expect(await sides(payment._id)).toEqual([
      [a.cash.id, 0, 100],
      [a.ali.id, 100, 0],
    ]);
    expect(await h.balanceOf(a.cash)).toBe(0);
  });

  it('keeps ledger entries append-only, and keeps an account with entries from being deleted', async () => {
    const { a, line, receive } = await setup();
    const receipt = await receive(a.cash, [line(a.scrap, 25)]);
    await h.receipts.remove(receipt.id);

    // The receipt is gone, but its posting and reversal stay in the ledger...
    expect(await h.models.entry.countDocuments({ voucherId: receipt._id }).exec()).toBe(4);
    await expect(h.models.entry.updateMany({}, { $set: { debit: 0 } }).exec()).rejects.toBeInstanceOf(
      InsertOnlyViolationError,
    );
    await expect(h.models.entry.deleteMany({}).exec()).rejects.toBeInstanceOf(InsertOnlyViolationError);
    // ...so the accounts it touched still have history and can't be deleted.
    await expect(h.ledger.remove(a.scrap.id)).rejects.toThrow(/used by ledger entries/);
  });

  it('writes no ledger entries for a rejected edit', async () => {
    const { a, line, receive } = await setup();
    const receipt = await receive(a.cash, [line(a.ali, 10)]);
    const before = await h.models.entry.countDocuments().exec();
    await expect(h.receipts.update(receipt.id, { comments: undefined }, user)).rejects.toThrow('No changes to save');
    await expect(h.receipts.update(receipt.id, { lines: [line(a.bank, 10)] }, user)).rejects.toThrow(
      /is a bank account/,
    );
    expect(await h.models.entry.countDocuments().exec()).toBe(before);
  });
});
