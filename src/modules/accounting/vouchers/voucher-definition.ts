import type { CodeSequence } from '../../sequence/code-sequence.js';
import type { Permission } from '../../roles/permissions.js';
import type { LedgerAccountType } from '../ledger-accounts/schemas/ledger-account.schema.js';
import type { VoucherDocument } from './schemas/voucher.schema.js';

/** Which side of the ledger the header account is on. */
export enum VoucherDirection {
  /** Money in: debit the header (cash/bank) account, credit each line account. */
  RECEIPT = 'receipt',
  /** Money out: credit the header (cash/bank) account, debit each line account. */
  PAYMENT = 'payment',
}

/** Which vouchers an "own"-scoped user sees. */
export enum VoucherScopeRule {
  /** Ones they created, or collected by them. */
  CREATOR_OR_COLLECTOR = 'creator-or-collector',
}

/**
 * Everything that differs between voucher types. VoucherPostingService and
 * VoucherPrintService do all the work; a voucher module only supplies this.
 */
export interface VoucherDefinition {
  /** Audit, comments and ledger entry type, e.g. "cash-receipt". */
  entityType: string;
  /** For messages, e.g. "Cash receipt". */
  label: string;
  sequence: CodeSequence;
  direction: VoucherDirection;
  /** Name of the header account field on the document, e.g. "cashAccountId". */
  headerField: string;
  /** e.g. "Received into" / "Paid from"; used in diffs, messages and the PDF. */
  headerLabel: string;
  /** Account types the header may use; defaults to cash, wallet and bank. */
  headerAccountTypes?: readonly LedgerAccountType[];
  lineAccountTypes: readonly LedgerAccountType[];
  /** Completes "Line 2: X is a bank account. ..." when a line account has the wrong type. */
  lineTypeHint: string;
  /** Payments: warn (and require acknowledgement) before taking a cash or wallet account below zero. */
  warnOnOverdraw: boolean;
  /** Usage registry source name, e.g. "cash receipts". */
  usageSource: string;
  /** Needed to read the voucher, its comments and its activity. */
  readPermission: Permission;
  /** The collector's role must hold this to be put on the voucher (Collected By / Paid By). */
  createPermission: Permission;
  /** Defaults to CREATOR_OR_COLLECTOR. */
  scopeRule?: VoucherScopeRule;
  /** What the voucher's collector is called in diffs and on the PDF, e.g. "Collected By". */
  collectorLabel: string;
  pdf: {
    /** Title by payment method. */
    /** Title by payment method; cheque falls back to the cash title. */
    titles: { cash: string; bank: string; cheque?: string };
    /** Header row value when the voucher has no single header account (handovers); defaults to headerField's name. */
    headerAccountName?: (voucher: VoucherDocument) => string;
    /** PDF metadata title prefix, e.g. "Cash Receipt". */
    documentTitle: string;
    /** Column heading for the line account, e.g. "Received From" / "Paid To". */
    counterpartyColumn: string;
    signatures: readonly [string, string];
    /** More rows for the PDF's info table, from the voucher's own extra fields. */
    extraInfo?: (voucher: VoucherDocument) => { label: string; value: string }[];
    /** Rows and totals to print instead of the posted lines; undefined keeps the lines. */
    body?: (voucher: VoucherDocument) =>
      | {
          lines: { counterparty: string; narration: string | null; amount: number; vat: number; netAmount: number }[];
          grossTotal: number;
          totalTax: number;
          grandTotal: number;
        }
      | undefined;
  };
}
