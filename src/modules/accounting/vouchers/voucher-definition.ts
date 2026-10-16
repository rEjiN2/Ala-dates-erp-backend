import type { CodeSequence } from '../../sequence/code-sequence.js';
import type { LedgerAccountType } from '../ledger-accounts/schemas/ledger-account.schema.js';

/** Which side of the ledger the header account is on. */
export enum VoucherDirection {
  /** Money in: debit the header (cash/bank) account, credit each line account. */
  RECEIPT = 'receipt',
  /** Money out: credit the header (cash/bank) account, debit each line account. */
  PAYMENT = 'payment',
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
  lineAccountTypes: readonly LedgerAccountType[];
  /** Completes "Line 2: X is a bank account. ..." when a line account has the wrong type. */
  lineTypeHint: string;
  /** Payments: warn (and require acknowledgement) before taking a cash or wallet account below zero. */
  warnOnOverdraw: boolean;
  /** Usage registry source name, e.g. "cash receipts". */
  usageSource: string;
  pdf: {
    /** Title by payment method. */
    titles: { cash: string; bank: string };
    /** PDF metadata title prefix, e.g. "Cash Receipt". */
    documentTitle: string;
    /** Column heading for the line account, e.g. "Received From" / "Paid To". */
    counterpartyColumn: string;
    signatures: readonly [string, string];
  };
}
