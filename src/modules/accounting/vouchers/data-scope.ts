import { ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { DataScope } from '../../roles/permissions.js';
import { VoucherScopeRule } from './voucher-definition.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';

/**
 * Per-user data scoping for vouchers. A user whose role has dataScope "own"
 * sees only vouchers they created or that are on their linked cashier;
 * anything else behaves as if it did not exist (404). On create they post
 * only for their own cashier, into one of their allowed cash accounts (403).
 *
 * Callers pass the authenticated user. A bare Actor ({ id, name }) has no
 * dataScope and counts as "all": only the JWT strategy sets the scope.
 */
export type ScopedUser = Pick<AuthenticatedUser, 'id' | 'name' | 'dataScope' | 'allowedCashAccountIds'>;

/** The linked cashier of a user, as far as scoping needs it. */
export interface LinkedCashier {
  id: string;
  code: string;
  name: string;
}

export function isOwnScope(user: ScopedUser | undefined): user is ScopedUser {
  return user?.dataScope === DataScope.OWN;
}

/** Matches no document: an "own"-scoped user with no cashier sees nothing under the CASHIER rule. */
const NOTHING = { _id: { $exists: false } };

/** Mongo filter for the vouchers `user` may see, or null when they see all. Builds ObjectIds itself, so it is safe in $match. */
export function voucherScopeFilter(
  user: ScopedUser | undefined,
  linkedCashier: LinkedCashier | null,
  rule: VoucherScopeRule = VoucherScopeRule.CREATOR_OR_CASHIER,
): Record<string, unknown> | null {
  if (!isOwnScope(user)) {
    return null;
  }
  if (rule === VoucherScopeRule.CASHIER) {
    return linkedCashier ? { cashierId: new Types.ObjectId(linkedCashier.id) } : NOTHING;
  }
  const mine: Record<string, unknown>[] = [{ 'createdBy.id': new Types.ObjectId(user.id) }];
  if (linkedCashier) {
    mine.push({ cashierId: new Types.ObjectId(linkedCashier.id) });
  }
  return { $or: mine };
}

/** Combines a query filter with a scope filter without clobbering either one's $or. */
export function withScope<F extends object>(filter: F, scope: Record<string, unknown> | null): F {
  return scope ? ({ $and: [filter, scope] } as unknown as F) : filter;
}

/**
 * The cashier an "own"-scoped user's new voucher goes on: always their linked
 * cashier. Sending another one is refused rather than silently replaced.
 */
export function resolveScopedCashier(
  linkedCashier: LinkedCashier | null,
  requestedCashierId: string | null | undefined,
  label: string,
): string {
  if (!linkedCashier) {
    throw new ForbiddenException(
      `Your user is not linked to a cashier, so you cannot enter a ${label.toLowerCase()}. Ask an administrator to link you to one.`,
    );
  }
  if (requestedCashierId && requestedCashierId !== linkedCashier.id) {
    throw new ForbiddenException(
      `You can only enter vouchers for your own cashier, ${linkedCashier.code} (${linkedCashier.name}).`,
    );
  }
  return linkedCashier.id;
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
