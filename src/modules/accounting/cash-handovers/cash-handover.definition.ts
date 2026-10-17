import { Permission } from '../../roles/permissions.js';
import { LedgerAccountType } from '../ledger-accounts/schemas/ledger-account.schema.js';
import { VoucherDirection, VoucherScopeRule, type VoucherDefinition } from '../vouchers/voucher-definition.js';
import { CASH_HANDOVER_ENTITY_TYPE } from './schemas/cash-handover.schema.js';

/** Both sides of a handover are the company's own money accounts. */
export const HANDOVER_ACCOUNT_TYPES: readonly LedgerAccountType[] = [
  LedgerAccountType.CASH,
  LedgerAccountType.WALLET,
  LedgerAccountType.BANK,
];

/**
 * Money moved between the company's own accounts: credit the "from" account
 * (the header), debit the "to" account (the single line). Taking a cash or
 * wallet "from" account below zero needs acknowledgeWarnings: true. An
 * "own"-scoped user sees only handovers their cashier handed over.
 */
export const CASH_HANDOVER_DEFINITION: VoucherDefinition = {
  entityType: CASH_HANDOVER_ENTITY_TYPE,
  label: 'Cash handover',
  sequence: { key: 'cash-handover', prefix: 'CH-', width: 4 },
  direction: VoucherDirection.PAYMENT,
  headerField: 'fromAccountId',
  headerLabel: 'From account',
  cashierLabel: 'Handed by',
  lineAccountTypes: HANDOVER_ACCOUNT_TYPES,
  lineTypeHint: 'Money can only be handed over into a cash, wallet or bank account.',
  warnOnOverdraw: true,
  usageSource: 'cash handovers',
  readPermission: Permission.CASH_HANDOVERS_READ,
  scopeRule: VoucherScopeRule.CASHIER,
  pdf: {
    titles: { cash: 'CASH HANDOVER VOUCHER', bank: 'CASH HANDOVER VOUCHER' },
    documentTitle: 'Cash Handover',
    counterpartyColumn: 'To Account',
    signatures: ['Handed By', 'Received By'],
    extraInfo: (voucher) => [{ label: 'Received By', value: String(voucher.get('receivedByCashierName') ?? '-') }],
  },
};
