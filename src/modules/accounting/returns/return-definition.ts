import { Types } from 'mongoose';
import { AllocationTargetType } from '../allocations/schemas/allocation.schema.js';
import { SYSTEM_ACCOUNTS } from '../ledger-accounts/schemas/ledger-account.schema.js';
import { isOwnScope } from '../vouchers/data-scope.js';
import { PURCHASE_RETURN_ENTITY_TYPE, SALES_RETURN_ENTITY_TYPE } from './schemas/return.schema.js';
import { PURCHASE_INVOICE_ENTITY_TYPE } from '../../purchase/purchase-invoices/schemas/purchase-invoice.schema.js';
import { SALES_INVOICE_ENTITY_TYPE } from '../../sales/sales-invoices/schemas/sales-invoice.schema.js';
import { PartyKind } from '../../party/schemas/party.schema.js';
import { stockLocationScope } from '../../stock/stock.service.js';
import { Permission } from '../../roles/permissions.js';
import type { CodeSequence } from '../../sequence/code-sequence.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';

type SystemAccount = (typeof SYSTEM_ACCOUNTS)[keyof typeof SYSTEM_ACCOUNTS];

/**
 * What differs between a sales return (credit note) and a purchase return
 * (debit note); ReturnService does the rest. Same idea as VoucherDefinition.
 */
export interface ReturnDefinition {
  entityType: string;
  invoiceEntityType: string;
  /** "Sales return". */
  label: string;
  /** "Sales invoice". */
  invoiceLabel: string;
  sequence: CodeSequence;
  /** What the credit is applied to. */
  targetType: AllocationTargetType;
  partyKind: PartyKind;
  /** Where the invoice document keeps its party and the party's ledger account. */
  invoicePartyField: 'customerId' | 'supplierId';
  invoicePartyAccountField: 'customerAccountId' | 'supplierAccountId';
  /** Sales Returns / Purchase Returns: takes the net before VAT. */
  contraAccount: SystemAccount;
  /** VAT Output / VAT Input: takes the tax. */
  vatAccount: SystemAccount;
  /** true: the party is credited, the other two debited (sales); false: the reverse (purchase). */
  partyCredited: boolean;
  /** Sales: restocked lines come back in. Purchase: every stock line goes out. */
  stockDirection: 'in' | 'out';
  /** The cost snapshot is shown only with products:view-cost. */
  hidesCost: boolean;
  readPermission: Permission;
  /**
   * What a scoped user may see; null = everything. Returns and the invoices
   * they name share these fields, so the same filter serves both.
   */
  scope: (user: AuthenticatedUser | undefined) => Record<string, unknown> | null;
  pdf: {
    title: string;
    documentTitle: string;
    partyLabel: string;
    partyTrnLabel: string;
    signatures: readonly [string, string];
  };
}

/** "own"-scoped users: returns of invoices they sold or created. */
function salesScope(user: AuthenticatedUser | undefined): Record<string, unknown> | null {
  if (!isOwnScope(user)) return null;
  const me = new Types.ObjectId(user.id);
  return { $or: [{ 'createdBy.id': me }, { soldById: me }] };
}

/** "own"-scoped users: only their allowed locations. */
function locationScope(user: AuthenticatedUser | undefined): Record<string, unknown> | null {
  const allowed = stockLocationScope(user);
  return allowed ? { locationId: { $in: allowed.map((id) => new Types.ObjectId(id)) } } : null;
}

export const SALES_RETURN_DEFINITION: ReturnDefinition = {
  entityType: SALES_RETURN_ENTITY_TYPE,
  invoiceEntityType: SALES_INVOICE_ENTITY_TYPE,
  label: 'Sales return',
  invoiceLabel: 'Sales invoice',
  sequence: { key: 'sales-return', prefix: 'SR-', width: 4 },
  targetType: AllocationTargetType.SALES_INVOICE,
  partyKind: PartyKind.CUSTOMER,
  invoicePartyField: 'customerId',
  invoicePartyAccountField: 'customerAccountId',
  contraAccount: SYSTEM_ACCOUNTS.SALES_RETURNS,
  vatAccount: SYSTEM_ACCOUNTS.VAT_OUTPUT,
  partyCredited: true,
  stockDirection: 'in',
  hidesCost: true,
  readPermission: Permission.SALES_RETURNS_READ,
  scope: salesScope,
  pdf: {
    title: 'CREDIT NOTE',
    documentTitle: 'Credit Note',
    partyLabel: 'Customer',
    partyTrnLabel: 'Customer TRN',
    signatures: ['Prepared by', 'Received by'],
  },
};

export const PURCHASE_RETURN_DEFINITION: ReturnDefinition = {
  entityType: PURCHASE_RETURN_ENTITY_TYPE,
  invoiceEntityType: PURCHASE_INVOICE_ENTITY_TYPE,
  label: 'Purchase return',
  invoiceLabel: 'Purchase invoice',
  sequence: { key: 'purchase-return', prefix: 'PR-', width: 4 },
  targetType: AllocationTargetType.PURCHASE_INVOICE,
  partyKind: PartyKind.SUPPLIER,
  invoicePartyField: 'supplierId',
  invoicePartyAccountField: 'supplierAccountId',
  contraAccount: SYSTEM_ACCOUNTS.PURCHASE_RETURNS,
  vatAccount: SYSTEM_ACCOUNTS.VAT_INPUT,
  partyCredited: false,
  stockDirection: 'out',
  hidesCost: false,
  readPermission: Permission.PURCHASE_RETURNS_READ,
  scope: locationScope,
  pdf: {
    title: 'DEBIT NOTE',
    documentTitle: 'Debit Note',
    partyLabel: 'Supplier',
    partyTrnLabel: 'Supplier TRN',
    signatures: ['Prepared by', 'Received by'],
  },
};
