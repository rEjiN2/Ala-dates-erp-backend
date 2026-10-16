import type { CodeSequence } from '../sequence/code-sequence.js';
import { LedgerAccountType } from '../accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { PartyKind } from './schemas/party.schema.js';

/** CUS-0001... for customers and SUP-0001... for suppliers, each with its own counter. */
export const PARTY_CODE_SEQUENCES: Readonly<Record<PartyKind, CodeSequence>> = {
  [PartyKind.CUSTOMER]: { key: 'party:customer', prefix: 'CUS-', width: 4 },
  [PartyKind.SUPPLIER]: { key: 'party:supplier', prefix: 'SUP-', width: 4 },
};

/** The ledger account type behind each kind of party. */
export const PARTY_LEDGER_TYPES: Readonly<Record<PartyKind, LedgerAccountType>> = {
  [PartyKind.CUSTOMER]: LedgerAccountType.PARTY,
  [PartyKind.SUPPLIER]: LedgerAccountType.SUPPLIER,
};
