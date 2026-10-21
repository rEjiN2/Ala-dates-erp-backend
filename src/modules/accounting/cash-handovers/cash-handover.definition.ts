import { Permission } from '../../roles/permissions.js';
import { VoucherDirection, type VoucherDefinition } from '../vouchers/voucher-definition.js';
import { CASH_HANDOVER_ENTITY_TYPE, type HandoverLine } from './schemas/cash-handover.schema.js';
import { sum2 } from '../../../common/utils/money.util.js';

const money = (value: unknown) => (typeof value === 'number' ? value.toFixed(2) : '-');

/**
 * Handovers post per item on approval (VoucherPostingService.postTransfers),
 * not header against lines; this definition gives them a number, scope,
 * comments, activity and the slip. headerField points at the items' sources
 * so an account used on one can't be deleted. An "own"-scoped user sees
 * only handovers they handed over or submitted.
 */
export const CASH_HANDOVER_DEFINITION: VoucherDefinition = {
  entityType: CASH_HANDOVER_ENTITY_TYPE,
  label: 'Cash handover',
  sequence: { key: 'handover', prefix: 'HO-', width: 4 },
  direction: VoucherDirection.PAYMENT,
  headerField: 'items.sourceAccountId',
  headerLabel: 'Handed over from',
  lineAccountTypes: [],
  lineTypeHint: '',
  warnOnOverdraw: false,
  usageSource: 'cash handovers',
  readPermission: Permission.CASH_HANDOVERS_READ,
  createPermission: Permission.CASH_HANDOVERS_CREATE,
  collectorLabel: 'Handed by',
  pdf: {
    titles: { cash: 'CASH HANDOVER SLIP', bank: 'CASH HANDOVER SLIP' },
    documentTitle: 'Cash Handover',
    counterpartyColumn: 'From -> Into',
    signatures: ['Handed By', 'Received By'],
    headerAccountName: (voucher) =>
      ((voucher.get('items') as HandoverLine[] | undefined) ?? []).map((item) => item.sourceAccountName).join(', '),
    extraInfo: (voucher) => {
      const get = (field: string) => voucher.get(field) as unknown;
      const rows = [
        { label: 'Status', value: String(get('status')).toUpperCase() },
        { label: 'Submitted', value: money(get('submittedTotal')) },
        { label: 'Received', value: money(get('receivedTotal')) },
      ];
      if (get('reason')) rows.push({ label: 'Reason', value: String(get('reason')) });
      return rows;
    },
    body: (voucher) => {
      const items = (voucher.get('items') as HandoverLine[] | undefined) ?? [];
      const amounts = items.map((item) => item.receivedAmount ?? item.submittedAmount);
      return {
        lines: items.map((item, index) => ({
          counterparty: `${item.sourceAccountName} -> ${item.receivedIntoAccountName ?? '-'}`,
          narration: `Submitted ${item.submittedAmount.toFixed(2)}`,
          amount: amounts[index],
          vat: 0,
          netAmount: amounts[index],
        })),
        grossTotal: sum2(amounts),
        totalTax: 0,
        grandTotal: sum2(amounts),
      };
    },
  },
};
