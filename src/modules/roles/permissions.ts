/**
 * Every permission string a route can require. Keep @RequirePermission(...)
 * arguments pointing here so the admin role below can't drift out of sync.
 */
export const Permission = {
  ACCOUNTS_MANAGE: 'accounts:manage',
  CASH_RECEIPTS_MANAGE: 'cash-receipts:manage',
  CASH_PAYMENTS_MANAGE: 'cash-payments:manage',
  CASHIERS_MANAGE: 'cashiers:manage',
  COMPANY_MANAGE: 'company:manage',
  LOCATIONS_MANAGE: 'locations:manage',
  PARTIES_MANAGE: 'parties:manage',
  PRODUCT_GROUPS_MANAGE: 'product-groups:manage',
  /** Read every ledger balance (incl. each party/supplier) in one call. */
  DASHBOARD_VIEW: 'dashboard:view',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const ADMIN_ROLE_NAME = 'admin';

/** The admin role holds every permission by default. */
export const ADMIN_PERMISSIONS: readonly Permission[] = Object.values(Permission);
