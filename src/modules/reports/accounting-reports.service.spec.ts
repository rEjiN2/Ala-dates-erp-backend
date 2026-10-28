import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createVoucherHarness, makeUser, type VoucherHarness } from '../../../test/voucher-test-module.js';
import { LedgerAccountType, type LedgerAccountDocument } from '../accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { REQUIRE_PERMISSION_KEY } from '../../common/decorators/require-permission.decorator.js';
import { ACCOUNTANT_PERMISSIONS, ADMIN_PERMISSIONS, Permission, VAN_SALESMAN_PERMISSIONS } from '../roles/permissions.js';
import { ReportsController } from './reports.controller.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';

const { CASH, PARTY, EXPENSE } = LedgerAccountType;
type Report = Record<string, any>;

describe('Accounting reports', () => {
  let h: VoucherHarness;
  let office: AuthenticatedUser;
  let cash: LedgerAccountDocument;
  let customer: LedgerAccountDocument;
  let expense: LedgerAccountDocument;

  beforeAll(async () => {
    h = await createVoucherHarness('accounting_reports');
  }, 120_000);
  afterAll(async () => {
    await h?.app.close();
  });
  beforeEach(async () => {
    cash = await h.makeAccount('CASH-0001', CASH, 0, 'Office Cash');
    customer = await h.makeAccount('CUS-0001', PARTY, 0, 'Ali Traders');
    expense = await h.makeAccount('EXP-0001', EXPENSE, 0, 'Fuel');
    office = await h.persistUser(makeUser('Office', [...ACCOUNTANT_PERMISSIONS]));
    await h.company.ensure();
  });
  afterEach(async () => {
    h.harness.tokenUser = makeUser('Sachin');
    await h.reset();
  });

  const receipt = (amount: number, date: string) =>
    h.receipts.create(
      { voucherDate: date, cashAccountId: cash.id as string, lines: [{ accountId: customer.id as string, amount }] },
      office,
    );
  const run = (name: 'ledger' | 'dayBook' | 'cashBook' | 'trialBalance', query: object) =>
    (h.accountingReports[name] as (q: object) => Promise<Report>)(query);

  async function mix() {
    await receipt(500, '2026-10-01');
    const cancelled = await receipt(300, '2026-10-02');
    await receipt(100, '2026-10-03');
    await h.receipts.cancel(cancelled.id as string, { reason: 'Wrong' }, office);
    await h.payments.create(
      { voucherDate: '2026-10-03', paidFromAccountId: cash.id as string, lines: [{ accountId: expense.id as string, amount: 40 }] },
      office,
    );
  }

  it('ledger closing equals the account balance; cancelled hidden unless asked', async () => {
    await mix();
    const ledger = await run('ledger', { accountId: customer.id });
    expect(ledger.rows.map((r: Report) => r.voucherNo)).toHaveLength(2);
    expect(ledger.closing).toBe((await h.models.account.findById(customer.id).lean())!.balance);
    expect(ledger.closing).toBe(-600);
    expect(ledger.rows.at(-1).runningBalance).toBe(-600);

    const withCancelled = await run('ledger', { accountId: customer.id, includeCancelled: 'true' === 'true' });
    expect(withCancelled.rows).toHaveLength(4);
    expect(withCancelled.rows.filter((r: Report) => r.cancelled)).toHaveLength(2);
    expect(withCancelled.closing).toBe(-600);

    const ranged = await run('ledger', { accountId: customer.id, dateFrom: '2026-10-03' });
    expect(ranged.opening).toBe(-500);
    expect(ranged.closing).toBe(-600);
  });

  it('cash book closing equals the account balance', async () => {
    await mix();
    const book = await run('cashBook', {});
    expect(book.closing).toBe((await h.models.account.findById(cash.id).lean())!.balance);
    expect(book.daily.map((d: Report) => d.date)).toEqual(['2026-10-01', '2026-10-03']);
    expect(book.daily[1]).toMatchObject({ opening: 500, receipts: 100, payments: 40, closing: 560 });
  });

  it('trial balance debits equal credits; day book lists one row per voucher', async () => {
    await mix();
    const tb = await run('trialBalance', {});
    expect(tb.totals.debit).toBe(tb.totals.credit);
    expect(tb.totals.debit).toBeGreaterThan(0);

    const book = await run('dayBook', {});
    expect(book.rows).toHaveLength(4 - 1);
    expect(book.totals).toEqual(
      expect.arrayContaining([
        { type: 'cash-receipt', count: 2, amount: 600 },
        { type: 'cash-payment', count: 1, amount: 40 },
      ]),
    );
    expect((await run('dayBook', { includeCancelled: true })).rows.find((r: Report) => r.status === 'cancelled').amount).toBe(300);
  });

  it('exports CSV and PDF', async () => {
    await mix();
    const csv = await h.accountingReports.ledger({ accountId: customer.id as string, format: 'csv' });
    const text = Buffer.from((csv as any).getStream().read() ?? '').toString('utf8');
    expect(text).toContain('Opening balance');
    const pdf = await h.accountingReports.trialBalance({ format: 'pdf' });
    expect(pdf).toBeDefined();
  });

  it('needs reports:accounting; scoped starter roles do not hold it', () => {
    for (const method of ['ledger', 'dayBook', 'cashBook', 'trialBalance'] as const) {
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, ReportsController.prototype[method])).toEqual([Permission.REPORTS_ACCOUNTING]);
    }
    expect(ADMIN_PERMISSIONS).toContain(Permission.REPORTS_ACCOUNTING);
    expect(ACCOUNTANT_PERMISSIONS).toContain(Permission.REPORTS_ACCOUNTING);
    expect(VAN_SALESMAN_PERMISSIONS).not.toContain(Permission.REPORTS_ACCOUNTING);
  });
});
