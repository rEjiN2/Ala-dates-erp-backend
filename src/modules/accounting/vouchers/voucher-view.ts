import { Permission, hasPermission } from '../../roles/permissions.js';
import type { VoucherDocument } from './schemas/voucher.schema.js';

/**
 * A voucher as the API returns it to `user`. Without balances:view each
 * line's oldBalance (the account's balance when it was posted) is left out.
 */
export function voucherView<T extends VoucherDocument>(
  voucher: T,
  user: { permissions?: readonly string[] },
): T | Record<string, unknown> {
  if (hasPermission(user, Permission.BALANCES_VIEW)) {
    return voucher;
  }
  const json = voucher.toJSON() as unknown as Record<string, unknown> & { lines?: Record<string, unknown>[] };
  return {
    ...json,
    lines: (json.lines ?? []).map(({ oldBalance: _oldBalance, ...line }) => line),
  };
}
