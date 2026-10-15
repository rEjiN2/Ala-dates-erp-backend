import type { CodeSequence } from '../../sequence/code-sequence.js';
import { LedgerAccountType } from './schemas/ledger-account.schema.js';

/** One counter per type the Accounts API manages. Party/supplier are absent: system-managed. */
export const LEDGER_ACCOUNT_CODE_SEQUENCES: Readonly<Partial<Record<LedgerAccountType, CodeSequence>>> = {
  [LedgerAccountType.CASH]: { key: 'ledger-account:cash', prefix: 'CASH-', width: 4 },
  [LedgerAccountType.BANK]: { key: 'ledger-account:bank', prefix: 'BNK-', width: 4 },
  [LedgerAccountType.WALLET]: { key: 'ledger-account:wallet', prefix: 'WAL-', width: 4 },
  [LedgerAccountType.INCOME]: { key: 'ledger-account:income', prefix: 'INC-', width: 4 },
  [LedgerAccountType.EXPENSE]: { key: 'ledger-account:expense', prefix: 'EXP-', width: 4 },
  [LedgerAccountType.OTHER]: { key: 'ledger-account:other', prefix: 'OTH-', width: 4 },
};

/** Types the Accounts API may create, update and delete. */
export const MANAGEABLE_ACCOUNT_TYPES = Object.keys(LEDGER_ACCOUNT_CODE_SEQUENCES) as LedgerAccountType[];
