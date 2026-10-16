import type { AuditChange } from '../../audit/schemas/audit-log.schema.js';
import { diffVoucher, type DiffableLine, type DiffableVoucher } from '../vouchers/voucher-diff.js';

export type { DiffableLine };

/** A receipt in diffable form: the generic voucher shape with the header named cashAccountId. */
export type DiffableCashReceipt = Omit<DiffableVoucher, 'headerAccountId'> & { cashAccountId: string };

/** The receipt flavour of diffVoucher: the header account reads as "Received into". */
export function diffCashReceipt(
  before: DiffableCashReceipt,
  after: DiffableCashReceipt,
  accountNames: ReadonlyMap<string, string>,
): AuditChange[] {
  const generic = ({ cashAccountId, ...rest }: DiffableCashReceipt): DiffableVoucher => ({
    ...rest,
    headerAccountId: cashAccountId,
  });
  return diffVoucher(generic(before), generic(after), accountNames, 'Received into');
}
