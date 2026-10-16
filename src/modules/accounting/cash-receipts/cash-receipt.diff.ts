import type { AuditChange } from '../../audit/schemas/audit-log.schema.js';
import { round2, sum2 } from '../../../common/utils/money.util.js';

/** The user-editable part of a receipt, in plain values. */
export interface DiffableCashReceipt {
  voucherDate: Date;
  cashAccountId: string;
  /** null only on receipts from before the cashier master. */
  cashierId: string | null;
  cashierName: string | null;
  paymentReference?: string | null;
  comments?: string | null;
  lines: readonly DiffableLine[];
}

export interface DiffableLine {
  accountId: string;
  amount: number;
  vat: number;
  narration?: string | null;
  remarks?: string | null;
}

const LINE_TEXT_FIELDS = [
  { key: 'narration', label: 'Narration' },
  { key: 'remarks', label: 'Remarks' },
] as const;

/**
 * Readable differences between two versions of a receipt. Empty means the
 * edit changes nothing a user can see.
 *
 * Lines carry no id of their own, so they are matched by account: the n-th
 * line for an account before pairs with the n-th line for that account after.
 * Moving a line to another account therefore reads as one line removed and
 * one added, and reordering lines is not a change.
 */
export function diffCashReceipt(
  before: DiffableCashReceipt,
  after: DiffableCashReceipt,
  accountNames: ReadonlyMap<string, string>,
): AuditChange[] {
  const nameOf = (accountId: string) => accountNames.get(accountId) ?? `Account ${accountId}`;
  const changes: AuditChange[] = [];

  const fromDate = formatDate(before.voucherDate);
  const toDate = formatDate(after.voucherDate);
  if (fromDate !== toDate) {
    changes.push({
      field: 'voucherDate',
      label: 'Date',
      from: fromDate,
      to: toDate,
    });
  }

  if (before.cashAccountId !== after.cashAccountId) {
    changes.push({
      field: 'cashAccount',
      label: 'Received into',
      from: nameOf(before.cashAccountId),
      to: nameOf(after.cashAccountId),
    });
  }

  // Compared by id: a cashier renamed in the master since is not a change here.
  if (before.cashierId !== after.cashierId) {
    changes.push({ field: 'cashier', label: 'Cashier', from: text(before.cashierName), to: text(after.cashierName) });
  }

  const fromReference = text(before.paymentReference);
  const toReference = text(after.paymentReference);
  if (fromReference !== toReference) {
    changes.push({ field: 'paymentReference', label: 'Payment reference', from: fromReference, to: toReference });
  }

  const fromComments = text(before.comments);
  const toComments = text(after.comments);
  if (fromComments !== toComments) {
    changes.push({ field: 'comments', label: 'Comments', from: fromComments, to: toComments });
  }

  changes.push(...diffLines(before.lines, after.lines, nameOf));

  const fromTotal = grandTotalOf(before.lines);
  const toTotal = grandTotalOf(after.lines);
  if (fromTotal !== toTotal) {
    changes.push({
      field: 'grandTotal',
      label: 'Total',
      from: fromTotal,
      to: toTotal,
    });
  }

  return changes;
}

function diffLines(
  before: readonly DiffableLine[],
  after: readonly DiffableLine[],
  nameOf: (accountId: string) => string,
): AuditChange[] {
  const changes: AuditChange[] = [];
  const beforeByAccount = groupByAccount(before);
  const afterByAccount = groupByAccount(after);
  // Accounts in the order they first appear, old lines first.
  const accountIds = [...new Set([...beforeByAccount.keys(), ...afterByAccount.keys()])];

  for (const accountId of accountIds) {
    const name = nameOf(accountId);
    const oldLines = beforeByAccount.get(accountId) ?? [];
    const newLines = afterByAccount.get(accountId) ?? [];

    for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
      const oldLine = oldLines[i];
      const newLine = newLines[i];

      if (!oldLine) {
        changes.push({
          field: 'lines',
          label: 'Line added',
          from: null,
          to: describeLine(name, newLine),
        });
        continue;
      }
      if (!newLine) {
        changes.push({
          field: 'lines',
          label: 'Line removed',
          from: describeLine(name, oldLine),
          to: null,
        });
        continue;
      }

      for (const { key, label } of [
        { key: 'amount', label: 'Amount' },
        { key: 'vat', label: 'VAT' },
      ] as const) {
        const from = round2(oldLine[key] ?? 0);
        const to = round2(newLine[key] ?? 0);
        if (from !== to) {
          changes.push({
            field: `lines.${key}`,
            label: `${name}: ${label}`,
            from,
            to,
          });
        }
      }
      for (const { key, label } of LINE_TEXT_FIELDS) {
        const from = text(oldLine[key]);
        const to = text(newLine[key]);
        if (from !== to) {
          changes.push({
            field: `lines.${key}`,
            label: `${name}: ${label}`,
            from,
            to,
          });
        }
      }
    }
  }

  return changes;
}

function groupByAccount(lines: readonly DiffableLine[]): Map<string, DiffableLine[]> {
  const groups = new Map<string, DiffableLine[]>();
  for (const line of lines) {
    const group = groups.get(line.accountId) ?? [];
    group.push(line);
    groups.set(line.accountId, group);
  }
  return groups;
}

/** e.g. "Ali Traders: 100.00 + VAT 5.00" */
function describeLine(name: string, line: DiffableLine): string {
  const vat = round2(line.vat ?? 0);
  return `${name}: ${round2(line.amount).toFixed(2)}${vat ? ` + VAT ${vat.toFixed(2)}` : ''}`;
}

function grandTotalOf(lines: readonly DiffableLine[]): number {
  return sum2(lines.map((line) => round2(line.amount) + round2(line.vat ?? 0)));
}

/** Blank and missing text are the same thing to a user. */
function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Voucher dates are entered as calendar days; show those as YYYY-MM-DD. */
function formatDate(value: Date): string {
  const iso = value.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
}
