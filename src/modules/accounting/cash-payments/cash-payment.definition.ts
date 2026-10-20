import { Permission } from '../../roles/permissions.js';
import { LedgerAccountType } from '../ledger-accounts/schemas/ledger-account.schema.js';
import { VoucherDirection, type VoucherDefinition } from '../vouchers/voucher-definition.js';
import { CASH_PAYMENT_ENTITY_TYPE } from './schemas/cash-payment.schema.js';

/**
 * Accounts money can be paid to on a payment line. Never the company's own
 * cash, wallet or bank accounts: that would be a transfer, not a payment.
 */
export const PAYMENT_LINE_ACCOUNT_TYPES: readonly LedgerAccountType[] = [
  LedgerAccountType.SUPPLIER,
  LedgerAccountType.PARTY,
  LedgerAccountType.EXPENSE,
  LedgerAccountType.INCOME,
  LedgerAccountType.OTHER,
];

/**
 * Money out: credit the "paid from" account for the grand total, debit each
 * line account for its net amount. Taking a cash or wallet account below
 * zero needs acknowledgeWarnings: true; bank accounts are exempt.
 */
export const CASH_PAYMENT_DEFINITION: VoucherDefinition = {
  entityType: CASH_PAYMENT_ENTITY_TYPE,
  label: 'Cash payment',
  sequence: { key: 'cash-payment', prefix: 'CP-', width: 4 },
  direction: VoucherDirection.PAYMENT,
  headerField: 'paidFromAccountId',
  headerLabel: 'Paid from',
  lineAccountTypes: PAYMENT_LINE_ACCOUNT_TYPES,
  lineTypeHint:
    "Money can't be paid to the company's own cash, wallet or bank accounts; choose a supplier, customer, expense, income or other account.",
  warnOnOverdraw: true,
  usageSource: 'cash payments',
  readPermission: Permission.CASH_PAYMENTS_READ,
  cashierLabel: 'Paid By',
  pdf: {
    titles: { cash: 'CASH PAYMENT VOUCHER', bank: 'BANK PAYMENT VOUCHER' },
    documentTitle: 'Cash Payment',
    counterpartyColumn: 'Paid To',
    signatures: ['Cashier Signature', 'Received by'],
  },
};
