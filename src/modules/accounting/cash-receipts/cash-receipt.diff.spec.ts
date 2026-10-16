import { describe, expect, it } from 'vitest';
import { diffCashReceipt, type DiffableCashReceipt } from './cash-receipt.diff.js';

const names = new Map([
  ['cash1', 'Main Cash'],
  ['cash2', 'Van Cash'],
  ['ali', 'Ali Traders'],
  ['omar', 'Omar Dates'],
  ['zaid', 'Zaid Foods'],
]);

const base: DiffableCashReceipt = {
  voucherDate: new Date('2026-09-21'),
  cashAccountId: 'cash1',
  cashierId: 'cashier-sachin',
  cashierName: 'Sachin',
  comments: 'Weekly collection',
  lines: [
    { accountId: 'ali', amount: 100, vat: 5, narration: 'Inv 1' },
    { accountId: 'omar', amount: 50, vat: 0 },
  ],
};

const diff = (after: Partial<DiffableCashReceipt>) => diffCashReceipt(base, { ...base, ...after }, names);

describe('diffCashReceipt', () => {
  it('is empty when nothing visible changed', () => {
    expect(diff({})).toEqual([]);
    // Reordered lines, blank vs missing text and float noise are not changes.
    expect(
      diff({
        // Same cashier, renamed in the master since: not a change on this receipt.
        cashierName: 'Sachin K',
        lines: [
          { accountId: 'omar', amount: 50.000000001, vat: 0, narration: '' },
          {
            accountId: 'ali',
            amount: 100,
            vat: 5,
            narration: 'Inv 1',
            remarks: null,
          },
        ],
      }),
    ).toEqual([]);
  });

  it('reports header fields with readable labels and account names', () => {
    expect(
      diff({
        voucherDate: new Date('2026-09-22'),
        cashAccountId: 'cash2',
        cashierId: 'cashier-omar',
        cashierName: 'Omar',
        comments: '',
      }),
    ).toEqual([
      {
        field: 'voucherDate',
        label: 'Date',
        from: '2026-09-21',
        to: '2026-09-22',
      },
      {
        field: 'cashAccount',
        label: 'Received into',
        from: 'Main Cash',
        to: 'Van Cash',
      },
      { field: 'cashier', label: 'Cashier', from: 'Sachin', to: 'Omar' },
      {
        field: 'comments',
        label: 'Comments',
        from: 'Weekly collection',
        to: null,
      },
    ]);
  });

  it('reports an amount change on a line, identified by account name, plus the new total', () => {
    expect(diff({ lines: [{ ...base.lines[0], amount: 250 }, base.lines[1]] })).toEqual([
      {
        field: 'lines.amount',
        label: 'Ali Traders: Amount',
        from: 100,
        to: 250,
      },
      { field: 'grandTotal', label: 'Total', from: 155, to: 305 },
    ]);
  });

  it('reports VAT and narration changes on a line', () => {
    expect(
      diff({
        lines: [{ ...base.lines[0], vat: 0, narration: 'Inv 2' }, base.lines[1]],
      }),
    ).toEqual([
      { field: 'lines.vat', label: 'Ali Traders: VAT', from: 5, to: 0 },
      {
        field: 'lines.narration',
        label: 'Ali Traders: Narration',
        from: 'Inv 1',
        to: 'Inv 2',
      },
      { field: 'grandTotal', label: 'Total', from: 155, to: 150 },
    ]);
  });

  it('reports an added line', () => {
    expect(
      diff({
        lines: [...base.lines, { accountId: 'zaid', amount: 20, vat: 1 }],
      }),
    ).toEqual([
      {
        field: 'lines',
        label: 'Line added',
        from: null,
        to: 'Zaid Foods: 20.00 + VAT 1.00',
      },
      { field: 'grandTotal', label: 'Total', from: 155, to: 176 },
    ]);
  });

  it('reports a removed line', () => {
    expect(diff({ lines: [base.lines[0]] })).toEqual([
      {
        field: 'lines',
        label: 'Line removed',
        from: 'Omar Dates: 50.00',
        to: null,
      },
      { field: 'grandTotal', label: 'Total', from: 155, to: 105 },
    ]);
  });

  it('reports a line moved to another account as removed + added, with no total change', () => {
    expect(
      diff({
        lines: [base.lines[0], { accountId: 'zaid', amount: 50, vat: 0 }],
      }),
    ).toEqual([
      {
        field: 'lines',
        label: 'Line removed',
        from: 'Omar Dates: 50.00',
        to: null,
      },
      {
        field: 'lines',
        label: 'Line added',
        from: null,
        to: 'Zaid Foods: 50.00',
      },
    ]);
  });

  it('pairs repeated lines for the same account in order', () => {
    const twoForAli: DiffableCashReceipt = {
      ...base,
      lines: [
        { accountId: 'ali', amount: 10, vat: 0 },
        { accountId: 'ali', amount: 20, vat: 0 },
      ],
    };
    expect(
      diffCashReceipt(twoForAli, { ...twoForAli, lines: [{ accountId: 'ali', amount: 10, vat: 0 }] }, names),
    ).toEqual([
      {
        field: 'lines',
        label: 'Line removed',
        from: 'Ali Traders: 20.00',
        to: null,
      },
      { field: 'grandTotal', label: 'Total', from: 30, to: 10 },
    ]);
  });

  it('falls back to the id for an account it has no name for', () => {
    expect(diff({ cashAccountId: 'gone' })).toEqual([
      {
        field: 'cashAccount',
        label: 'Received into',
        from: 'Main Cash',
        to: 'Account gone',
      },
    ]);
  });

  it('reports a payment reference being added, changed or cleared', () => {
    expect(diff({ paymentReference: 'CHQ 000123' })).toEqual([
      { field: 'paymentReference', label: 'Payment reference', from: null, to: 'CHQ 000123' },
    ]);
    const withRef = { ...base, paymentReference: 'CHQ 000123' };
    expect(diffCashReceipt(withRef, { ...withRef, paymentReference: ' CHQ 000123 ' }, names)).toEqual([]);
    expect(diffCashReceipt(withRef, { ...withRef, paymentReference: '' }, names)).toEqual([
      { field: 'paymentReference', label: 'Payment reference', from: 'CHQ 000123', to: null },
    ]);
  });
});
