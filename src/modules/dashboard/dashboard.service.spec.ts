import { describe, expect, it } from 'vitest';
import { DashboardService } from './dashboard.service.js';
import {
  LedgerAccountStatus,
  LedgerAccountType,
} from '../accounting/ledger-accounts/schemas/ledger-account.schema.js';
import type { LedgerAccountService } from '../accounting/ledger-accounts/ledger-account.service.js';

let nextId = 1;
function account(type: LedgerAccountType, code: string, balance: number, status = LedgerAccountStatus.ACTIVE) {
  return { id: `acc${nextId++}`, code, name: `${code} name`, type, balance, status };
}

function serviceWith(accounts: ReturnType<typeof account>[]) {
  const ledgerAccountService = { findAll: async () => accounts } as unknown as LedgerAccountService;
  return new DashboardService(ledgerAccountService);
}

describe('DashboardService.getSummary', () => {
  it('groups every account by type with a 2dp total per group', async () => {
    const summary = await serviceWith([
      account(LedgerAccountType.CASH, 'CASH-MAIN', 1000.1),
      account(LedgerAccountType.CASH, 'CASH-VAN1', 0.2),
      account(LedgerAccountType.PARTY, 'P-001', -250),
      account(LedgerAccountType.INCOME, 'INC-SALES', 500),
    ]).getSummary();

    const cash = summary.balancesByType.find((g) => g.type === LedgerAccountType.CASH)!;
    expect(cash.total).toBe(1000.3); // not 1000.3000000000001
    expect(cash.accountCount).toBe(2);
    expect(cash.accounts.map((a) => a.code)).toEqual(['CASH-MAIN', 'CASH-VAN1']);

    expect(summary.balancesByType.find((g) => g.type === LedgerAccountType.PARTY)!.total).toBe(-250);
  });

  it('always returns all eight types in enum order, wallet included, empty ones at zero', async () => {
    const summary = await serviceWith([account(LedgerAccountType.BANK, 'BANK-1', 10)]).getSummary();

    expect(summary.balancesByType.map((g) => g.type)).toEqual([
      'cash',
      'bank',
      'wallet',
      'party',
      'supplier',
      'income',
      'expense',
      'other',
    ]);
    const expense = summary.balancesByType.find((g) => g.type === LedgerAccountType.EXPENSE)!;
    expect(expense).toEqual({ type: LedgerAccountType.EXPENSE, total: 0, accountCount: 0, accounts: [] });
  });

  it('combines only cash, bank and wallet into the liquid-funds total', async () => {
    const summary = await serviceWith([
      account(LedgerAccountType.CASH, 'CASH-MAIN', 1200.55),
      account(LedgerAccountType.BANK, 'BANK-1', 8000.45),
      account(LedgerAccountType.WALLET, 'WAL-0001', 49.1),
      account(LedgerAccountType.INCOME, 'INC-SALES', 99999),
      account(LedgerAccountType.SUPPLIER, 'S-001', -4000),
    ]).getSummary();

    expect(summary.balancesByType.find((g) => g.type === LedgerAccountType.WALLET)!.total).toBe(49.1);
    expect(summary.cashAndBankTotal).toBe(9250.1);
  });

  it('leaves inactive wallets out of the liquid-funds total', async () => {
    const summary = await serviceWith([
      account(LedgerAccountType.WALLET, 'WAL-0001', 30),
      account(LedgerAccountType.WALLET, 'WAL-0002', 500, LedgerAccountStatus.INACTIVE),
    ]).getSummary();

    const wallet = summary.balancesByType.find((g) => g.type === LedgerAccountType.WALLET)!;
    expect(wallet).toMatchObject({ total: 30, accountCount: 2 });
    expect(summary.cashAndBankTotal).toBe(30);
  });

  it('lists inactive accounts but leaves them out of every total', async () => {
    const summary = await serviceWith([
      account(LedgerAccountType.CASH, 'CASH-MAIN', 100),
      account(LedgerAccountType.CASH, 'CASH-OLD', 50, LedgerAccountStatus.INACTIVE),
      account(LedgerAccountType.BANK, 'BANK-CLOSED', 7000, LedgerAccountStatus.INACTIVE),
      account(LedgerAccountType.PARTY, 'P-OLD', 300, LedgerAccountStatus.INACTIVE),
    ]).getSummary();

    const cash = summary.balancesByType.find((g) => g.type === LedgerAccountType.CASH)!;
    expect(cash.total).toBe(100);
    expect(cash.accountCount).toBe(2);
    expect(cash.accounts.find((a) => a.code === 'CASH-OLD')).toMatchObject({
      status: LedgerAccountStatus.INACTIVE,
      balance: 50,
    });

    const bank = summary.balancesByType.find((g) => g.type === LedgerAccountType.BANK)!;
    expect(bank.total).toBe(0);
    expect(bank.accounts).toHaveLength(1);

    expect(summary.balancesByType.find((g) => g.type === LedgerAccountType.PARTY)!.total).toBe(0);
    expect(summary.cashAndBankTotal).toBe(100);
  });

  it('returns a zeroed summary when no accounts exist', async () => {
    const summary = await serviceWith([]).getSummary();

    expect(summary.cashAndBankTotal).toBe(0);
    expect(summary.balancesByType.every((g) => g.total === 0 && g.accounts.length === 0)).toBe(true);
    expect(Number.isNaN(Date.parse(summary.asOf))).toBe(false);
  });
});
