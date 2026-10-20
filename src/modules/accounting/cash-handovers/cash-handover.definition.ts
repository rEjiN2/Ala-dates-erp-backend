import { Permission } from '../../roles/permissions.js';
import { LedgerAccountType } from '../ledger-accounts/schemas/ledger-account.schema.js';
import { VoucherDirection, VoucherScopeRule, type VoucherDefinition } from '../vouchers/voucher-definition.js';
import { CASH_HANDOVER_ENTITY_TYPE, type HandoverReceipt } from './schemas/cash-handover.schema.js';
import { sum2 } from '../../../common/utils/money.util.js';

/** Accounts handed-over cash can be received into. */
export const HANDOVER_ACCOUNT_TYPES: readonly LedgerAccountType[] = [
  LedgerAccountType.CASH,
  LedgerAccountType.WALLET,
  LedgerAccountType.BANK,
];

/** Accounts the van's cash can come from. */
export const HANDOVER_SOURCE_ACCOUNT_TYPES: readonly LedgerAccountType[] = [
  LedgerAccountType.CASH,
  LedgerAccountType.WALLET,
];

const money = (value: unknown) => (typeof value === 'number' ? value.toFixed(2) : '-');

/**
 * On approval: credit the source (header) account, debit the receiving
 * account (the single line) with receivedCash only. CashHandoverService runs
 * the workflow; VoucherPostingService writes the entries. An "own"-scoped
 * user sees only handovers of their own staff record.
 */
export const CASH_HANDOVER_DEFINITION: VoucherDefinition = {
  entityType: CASH_HANDOVER_ENTITY_TYPE,
  label: 'Cash handover',
  sequence: { key: 'cash-handover', prefix: 'CH-', width: 4 },
  direction: VoucherDirection.PAYMENT,
  headerField: 'fromAccountId',
  headerLabel: 'Source account',
  cashierLabel: 'Handed by',
  lineAccountTypes: HANDOVER_ACCOUNT_TYPES,
  lineTypeHint: 'Money can only be handed over into a cash, wallet or bank account.',
  warnOnOverdraw: false,
  usageSource: 'cash handovers',
  readPermission: Permission.CASH_HANDOVERS_READ,
  scopeRule: VoucherScopeRule.CASHIER,
  pdf: {
    titles: { cash: 'CASH HANDOVER SLIP', bank: 'CASH HANDOVER SLIP' },
    documentTitle: 'Cash Handover',
    counterpartyColumn: 'Receipt',
    signatures: ['Handed By', 'Received By'],
    extraInfo: (voucher) => {
      const get = (field: string) => voucher.get(field) as unknown;
      const rows = [
        { label: 'Status', value: String(get('status')).toUpperCase() },
        { label: 'Expected Cash', value: money(get('expectedCash')) },
        { label: 'Bank Total', value: money(get('bankTotal')) },
        { label: 'Counted Cash', value: money(get('countedCash')) },
        { label: 'Received Cash', value: money(get('receivedCash')) },
        { label: 'Received Into', value: String(get('receivedIntoAccountName') ?? '-') },
      ];
      if (get('varianceReason')) rows.push({ label: 'Variance Reason', value: String(get('varianceReason')) });
      if (get('rejectReason')) rows.push({ label: 'Reject Reason', value: String(get('rejectReason')) });
      return rows;
    },
    body: (voucher) => {
      const receipts = (voucher.get('receipts') as HandoverReceipt[] | undefined) ?? [];
      // Migrated handovers have no receipts: print their posted line instead.
      if (receipts.length === 0) return undefined;
      const total = sum2(receipts.map((receipt) => receipt.amount));
      return {
        lines: receipts.map((receipt) => ({
          counterparty: receipt.voucherNo,
          narration: receipt.paymentMethod === 'bank' ? 'Bank (verified)' : 'Cash',
          amount: receipt.amount,
          vat: 0,
          netAmount: receipt.amount,
        })),
        grossTotal: total,
        totalTax: 0,
        grandTotal: total,
      };
    },
  },
};
