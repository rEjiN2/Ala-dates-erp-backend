import { Permission } from '../../roles/permissions.js';
import { LedgerAccountType } from '../ledger-accounts/schemas/ledger-account.schema.js';
import { VoucherDirection, type VoucherDefinition } from '../vouchers/voucher-definition.js';
import { CASH_RECEIPT_ENTITY_TYPE } from './schemas/cash-receipt.schema.js';

/**
 * Accounts money can be received from on a receipt line. Never the company's
 * own cash, wallet or bank accounts: that would be a transfer, not a receipt.
 */
export const RECEIPT_LINE_ACCOUNT_TYPES: readonly LedgerAccountType[] = [
  LedgerAccountType.PARTY,
  LedgerAccountType.SUPPLIER,
  LedgerAccountType.INCOME,
  LedgerAccountType.EXPENSE,
  LedgerAccountType.OTHER,
];

/** Money in: debit the "received into" account, credit each line account. */
export const CASH_RECEIPT_DEFINITION: VoucherDefinition = {
  entityType: CASH_RECEIPT_ENTITY_TYPE,
  label: 'Cash receipt',
  sequence: { key: 'cash-receipt', prefix: 'CR', width: 6 },
  direction: VoucherDirection.RECEIPT,
  headerField: 'cashAccountId',
  headerLabel: 'Received into',
  headerAccountTypes: [LedgerAccountType.CASH, LedgerAccountType.WALLET, LedgerAccountType.CHEQUE, LedgerAccountType.BANK],
  scopeExemptHeaderTypes: [LedgerAccountType.BANK, LedgerAccountType.CHEQUE],
  lineAccountTypes: RECEIPT_LINE_ACCOUNT_TYPES,
  lineTypeHint:
    "Money can't be received from the company's own cash, wallet or bank accounts; choose a customer, supplier, income, expense or other account.",
  warnOnOverdraw: false,
  usageSource: 'cash receipts',
  readPermission: Permission.CASH_RECEIPTS_READ,
  createPermission: Permission.CASH_RECEIPTS_CREATE,
  collectorLabel: 'Collected By',
  pdf: {
    titles: { cash: 'CASH RECEIPT VOUCHER', bank: 'BANK RECEIPT VOUCHER', cheque: 'CHEQUE RECEIPT VOUCHER' },
    documentTitle: 'Cash Receipt',
    counterpartyColumn: 'Received From',
    signatures: ['Cashier Signature', 'Payer Signature'],
    extraInfo: (voucher) => {
      if (!voucher.chequeNumber) return [];
      const date = voucher.chequeDate ? voucher.chequeDate.toISOString().slice(0, 10) : '-';
      return [
        { label: 'Cheque No', value: voucher.chequeNumber },
        { label: 'Cheque Bank', value: voucher.chequeBankName ?? '-' },
        { label: 'Cheque Date', value: date },
        { label: 'Cheque Status', value: (voucher.chequeStatus ?? '-').toUpperCase().replace('_', ' ') },
      ];
    },
  },
};

export const CASH_RECEIPT_VOUCHER_SEQUENCE = CASH_RECEIPT_DEFINITION.sequence;
