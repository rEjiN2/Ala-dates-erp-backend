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
  /** The cheque register (GET /cheques) and a cheque's comments and activity. */
  CHEQUES_READ: 'cheques:read',
  CHEQUES_DEPOSIT: 'cheques:deposit',
  /** Clear a cheque: posts it from cheques in hand into the destination account. */
  CHEQUES_CLEAR: 'cheques:clear',
  /** Return (bounce) a cheque: reverses its receipt, so the customer owes again. */
  CHEQUES_RETURN: 'cheques:return',
  CASH_HANDOVERS_READ: 'cash-handovers:read',
  /** Submit a handover: your own, or another user's with vouchers:select-collector. */
  CASH_HANDOVERS_CREATE: 'cash-handovers:create',
  /** Approve or reject a submitted handover (posts the received amounts). Never your own. */
  CASH_HANDOVERS_APPROVE: 'cash-handovers:approve',
  /** Cancel any handover, approved ones included (reverses); a submitter may cancel their own submitted one without it. */
  CASH_HANDOVERS_CANCEL: 'cash-handovers:cancel',
  OPENING_BALANCES_READ: 'opening-balances:read',
  OPENING_BALANCES_CREATE: 'opening-balances:create',
  OPENING_BALANCES_EDIT: 'opening-balances:edit',
  OPENING_BALANCES_CANCEL: 'opening-balances:cancel',
  /** Stock summary and history; "own"-scoped users only for their allowedLocationIds. */
  STOCK_READ: 'stock:read',
  /** See the system (book) quantity and difference on a stock count; without it counts are blind. */
  STOCK_VIEW_SYSTEM_QTY: 'stock:view-system-qty',
  STOCK_COUNTS_READ: 'stock-counts:read',
  /** Create, edit and submit your own draft counts. */
  STOCK_COUNTS_CREATE: 'stock-counts:create',
  /** Approve (posts the differences) or reject a submitted count. Never your own. */
  STOCK_COUNTS_APPROVE: 'stock-counts:approve',
  /** Cancel a count, an approved one included (reverses its entries). */
  STOCK_COUNTS_CANCEL: 'stock-counts:cancel',
  OPENING_STOCK_READ: 'opening-stock:read',
  OPENING_STOCK_CREATE: 'opening-stock:create',
  OPENING_STOCK_EDIT: 'opening-stock:edit',
  OPENING_STOCK_CANCEL: 'opening-stock:cancel',
  /** Define and change bundle recipes (PUT /products/:id/recipe). */
  BUNDLES_MANAGE: 'bundles:manage',
  BUNDLING_READ: 'bundling:read',
  BUNDLING_CREATE: 'bundling:create',
  /** Undo a bundling (reverses its stock entries). */
  BUNDLING_CANCEL: 'bundling:cancel',
  /** Apply an on-account payment to a bill, or reverse an allocation. Allocating inside a payment needs only cash-payments:create. */
  ALLOCATIONS_MANAGE: 'allocations:manage',
  PURCHASE_INVOICES_READ: 'purchase-invoices:read',
  PURCHASE_INVOICES_CREATE: 'purchase-invoices:create',
  PURCHASE_INVOICES_EDIT: 'purchase-invoices:edit',
  PURCHASE_INVOICES_CANCEL: 'purchase-invoices:cancel',
  SALES_INVOICES_READ: 'sales-invoices:read',
  SALES_INVOICES_CREATE: 'sales-invoices:create',
  SALES_INVOICES_EDIT: 'sales-invoices:edit',
  SALES_INVOICES_CANCEL: 'sales-invoices:cancel',
  PURCHASE_RETURNS_READ: 'purchase-returns:read',
  PURCHASE_RETURNS_CREATE: 'purchase-returns:create',
  PURCHASE_RETURNS_EDIT: 'purchase-returns:edit',
  PURCHASE_RETURNS_CANCEL: 'purchase-returns:cancel',
  SALES_RETURNS_READ: 'sales-returns:read',
  SALES_RETURNS_CREATE: 'sales-returns:create',
  SALES_RETURNS_EDIT: 'sales-returns:edit',
  SALES_RETURNS_CANCEL: 'sales-returns:cancel',
  /** Sell at a rate other than the product's sale price. */
  SALES_OVERRIDE_PRICE: 'sales:override-price',
  /** Give any discount on a sales invoice line. */
  SALES_DISCOUNT: 'sales:discount',
  /** Sell beyond a customer's credit limit (with acknowledgeCredit: true). */
  SALES_OVERRIDE_CREDIT: 'sales:override-credit',
  COMPANY_MANAGE: 'company:manage',
  LOCATIONS_MANAGE: 'locations:manage',
  PARTIES_MANAGE: 'parties:manage',
  PRODUCT_GROUPS_MANAGE: 'product-groups:manage',
  PRODUCTS_MANAGE: 'products:manage',
  /** See purchase prices (cost) on products and their activity timeline. Never for van salesmen. */
  PRODUCTS_VIEW_COST: 'products:view-cost',
  UNITS_MANAGE: 'units:manage',
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

/** Every voucher and master permission; no user, role or company management; opening balances and stock read only. */
export const ACCOUNTANT_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter(
  (permission) =>
    permission !== Permission.USERS_MANAGE &&
    permission !== Permission.ROLES_MANAGE &&
    permission !== Permission.COMPANY_MANAGE &&
    permission !== Permission.OPENING_BALANCES_CREATE &&
    permission !== Permission.OPENING_BALANCES_EDIT &&
    permission !== Permission.OPENING_BALANCES_CANCEL &&
    permission !== Permission.OPENING_STOCK_CREATE &&
    permission !== Permission.OPENING_STOCK_EDIT &&
    permission !== Permission.OPENING_STOCK_CANCEL,
);

/** Enters receipts and submits handovers; sees only their own (dataScope own), no balances, no dashboard. */
export const VAN_SALESMAN_PERMISSIONS: readonly Permission[] = [
  Permission.CASH_RECEIPTS_READ,
  Permission.CASH_RECEIPTS_CREATE,
  Permission.CASH_HANDOVERS_READ,
  Permission.CASH_HANDOVERS_CREATE,
  Permission.SALES_INVOICES_READ,
  Permission.SALES_INVOICES_CREATE,
  Permission.SALES_RETURNS_READ,
  Permission.STOCK_COUNTS_READ,
  Permission.STOCK_COUNTS_CREATE,
];

export function hasPermission(user: { permissions?: readonly string[] } | undefined, permission: Permission): boolean {
  return Boolean(user?.permissions?.includes(permission));
}
