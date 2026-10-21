/**
 * Every permission string a route can require. Keep @RequirePermission(...)
 * arguments pointing here so the admin role below can't drift out of sync.
 */
export const Permission = {
  ACCOUNTS_MANAGE: 'accounts:manage',
  /** See ledger balances in lookups and on voucher lines (oldBalance). */
  BALANCES_VIEW: 'balances:view',
  CASH_RECEIPTS_READ: 'cash-receipts:read',
  CASH_RECEIPTS_CREATE: 'cash-receipts:create',
  CASH_RECEIPTS_EDIT: 'cash-receipts:edit',
  CASH_RECEIPTS_CANCEL: 'cash-receipts:cancel',
  CASH_PAYMENTS_READ: 'cash-payments:read',
  CASH_PAYMENTS_CREATE: 'cash-payments:create',
  CASH_PAYMENTS_EDIT: 'cash-payments:edit',
  CASH_PAYMENTS_CANCEL: 'cash-payments:cancel',
  CASH_HANDOVERS_READ: 'cash-handovers:read',
  /** Submit a handover: your own, or another user's with vouchers:select-collector. */
  CASH_HANDOVERS_CREATE: 'cash-handovers:create',
  /** Approve or reject a submitted handover (posts the received amounts). Never your own. */
  CASH_HANDOVERS_APPROVE: 'cash-handovers:approve',
  /** Cancel any handover, approved ones included (reverses); a submitter may cancel their own submitted one without it. */
  CASH_HANDOVERS_CANCEL: 'cash-handovers:cancel',
  COMPANY_MANAGE: 'company:manage',
  LOCATIONS_MANAGE: 'locations:manage',
  PARTIES_MANAGE: 'parties:manage',
  PRODUCT_GROUPS_MANAGE: 'product-groups:manage',
  /** The salesman collections report (cash collected vs handed over, per user who settles with the office). */
  REPORTS_SALESMAN: 'reports:salesman',
  ROLES_MANAGE: 'roles:manage',
  USERS_MANAGE: 'users:manage',
  /** Record a voucher as collected (receipt) or paid (payment) by another user; without it, always yourself. */
  VOUCHERS_SELECT_COLLECTOR: 'vouchers:select-collector',
  /** Read every ledger balance (incl. each party/supplier) in one call. */
  DASHBOARD_VIEW: 'dashboard:view',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

/**
 * Permissions that were split. A role still holding a key is given every
 * permission in its value instead (see migrateLegacyPermissions in the seed).
 */
export const LEGACY_PERMISSION_REPLACEMENTS: Readonly<Record<string, readonly Permission[]>> = {
  'cash-receipts:manage': [
    Permission.CASH_RECEIPTS_READ,
    Permission.CASH_RECEIPTS_CREATE,
    Permission.CASH_RECEIPTS_EDIT,
    Permission.CASH_RECEIPTS_CANCEL,
  ],
  'cash-payments:manage': [
    Permission.CASH_PAYMENTS_READ,
    Permission.CASH_PAYMENTS_CREATE,
    Permission.CASH_PAYMENTS_EDIT,
    Permission.CASH_PAYMENTS_CANCEL,
  ],
  // Handovers are never edited (submit, then approve/reject/cancel).
  'cash-handovers:edit': [],
  // The Cashier (Staff) master was removed: collectors are users now.
  'cashiers:manage': [],
};

/** Which records a role's users see: only their own ("own") or everyone's ("all"). */
export enum DataScope {
  OWN = 'own',
  ALL = 'all',
}

export const ADMIN_ROLE_NAME = 'admin';
export const ACCOUNTANT_ROLE_NAME = 'Accountant';
export const VAN_SALESMAN_ROLE_NAME = 'Van Salesman';

/** The admin role holds every permission by default. */
export const ADMIN_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS;

/** Every voucher and master permission; no user, role or company management. */
export const ACCOUNTANT_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter(
  (permission) =>
    permission !== Permission.USERS_MANAGE &&
    permission !== Permission.ROLES_MANAGE &&
    permission !== Permission.COMPANY_MANAGE,
);

/** Enters receipts and submits handovers; sees only their own (dataScope own), no balances, no dashboard. */
export const VAN_SALESMAN_PERMISSIONS: readonly Permission[] = [
  Permission.CASH_RECEIPTS_READ,
  Permission.CASH_RECEIPTS_CREATE,
  Permission.CASH_HANDOVERS_READ,
  Permission.CASH_HANDOVERS_CREATE,
];

export function hasPermission(user: { permissions?: readonly string[] } | undefined, permission: Permission): boolean {
  return Boolean(user?.permissions?.includes(permission));
}
