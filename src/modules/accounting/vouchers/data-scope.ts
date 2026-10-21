import { ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { DataScope, Permission, hasPermission } from '../../roles/permissions.js';
import { VoucherScopeRule } from './voucher-definition.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';

/**
 * Per-user data scoping for vouchers. A user whose role has dataScope "own"
 * sees only vouchers they created or that they collected (collectedById);
 * anything else behaves as if it did not exist (404). On create they post
 * only into one of their allowed cash accounts (403).
 *
 * Callers pass the authenticated user. A bare Actor ({ id, name }) has no
 * dataScope and counts as "all": only the JWT strategy sets the scope.
 */
export type ScopedUser = Pick<AuthenticatedUser, 'id' | 'name' | 'dataScope' | 'allowedCashAccountIds'> & {
  permissions?: readonly string[];
};

export function isOwnScope(user: ScopedUser | undefined): user is ScopedUser {
  return user?.dataScope === DataScope.OWN;
}

/** Mongo filter for the vouchers `user` may see, or null when they see all. Builds ObjectIds itself, so it is safe in $match. */
export function voucherScopeFilter(
  user: ScopedUser | undefined,
  rule: VoucherScopeRule = VoucherScopeRule.CREATOR_OR_COLLECTOR,
): Record<string, unknown> | null {
  if (!isOwnScope(user)) {
    return null;
  }
  const me = new Types.ObjectId(user.id);
  return { $or: [{ 'createdBy.id': me }, { collectedById: me }] };
}

/** Combines a query filter with a scope filter without clobbering either one's $or. */
export function withScope<F extends object>(filter: F, scope: Record<string, unknown> | null): F {
  return scope ? ({ $and: [filter, scope] } as unknown as F) : filter;
}

/**
 * Who a voucher is collected by: the caller unless they name someone else,
 * which needs vouchers:select-collector. Eligibility of the named user is
 * checked separately (UsersService.findEligibleCollector).
 */
export function resolveCollectorId(user: ScopedUser, requestedId: string | null | undefined): string {
  if (!requestedId || requestedId === user.id) {
    return user.id;
  }
  if (!hasPermission(user, Permission.VOUCHERS_SELECT_COLLECTOR)) {
    throw new ForbiddenException('You can only record vouchers collected by yourself.');
  }
  return requestedId;
}

/** An "own"-scoped user may only use the cash/wallet accounts assigned to them. */
export function assertScopedHeaderAccount(user: ScopedUser, headerAccountId: string, label: string): void {
  const allowed = user.allowedCashAccountIds ?? [];
  if (allowed.length === 0) {
    throw new ForbiddenException(
      `No cash accounts are assigned to your user, so you cannot enter a ${label.toLowerCase()}. Ask an administrator to assign one.`,
    );
  }
  if (!allowed.includes(headerAccountId)) {
    throw new ForbiddenException('You may not use this account. Choose one of the cash accounts assigned to you.');
  }
}
