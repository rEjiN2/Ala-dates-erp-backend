import type { Connection, Model, Types } from 'mongoose';
import type {
  LedgerAccountDocument,
  LedgerAccountType,
} from '../modules/accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { LEDGER_ACCOUNT_CODE_SEQUENCES } from '../modules/accounting/ledger-accounts/ledger-account-code.js';
import { isCanonicalSequenceCode, parseSequenceCode } from '../modules/sequence/code-sequence.js';
import type { SequenceService } from '../modules/sequence/sequence.service.js';
import { runInTransaction } from '../common/utils/transaction.util.js';

export interface LedgerAccountCodeBackfillResult {
  /** Accounts that received a generated code; the old one is kept in legacyCode. */
  recoded: { id: string; from: string; to: string }[];
  /** "type: name" groups that collide case-insensitively and will block the unique name index. */
  duplicateNames: string[];
}

interface AccountRow {
  _id: Types.ObjectId;
  code: string;
  legacyCode?: string;
  name: string;
  type: LedgerAccountType;
}

/**
 * One-time (re-runnable) step for accounts entered before codes were
 * generated. In a single transaction:
 *  1. raises each type's counter above every code already in the generated
 *     format (CASH-0007 etc.), whatever account holds it, so nothing collides;
 *  2. gives each cash/bank/wallet/income/expense/other account whose code is
 *     not in its type's format a generated code, oldest account first, and
 *     keeps the old code in `legacyCode`.
 * Only `code` and `legacyCode` are written: ids, balances and every reference
 * (vouchers point at accounts by id) are untouched. Party/supplier accounts
 * are skipped; their codes belong to the Parties module.
 *
 * Duplicate names are only reported, never renamed: a person has to decide.
 */
export async function backfillLedgerAccountCodes(deps: {
  connection: Connection;
  ledgerAccountModel: Model<LedgerAccountDocument>;
  sequenceService: SequenceService;
}): Promise<LedgerAccountCodeBackfillResult> {
  const { ledgerAccountModel, sequenceService } = deps;

  return runInTransaction(deps.connection, async (session) => {
    const accounts = await ledgerAccountModel
      .find()
      .select('code legacyCode name type createdAt')
      .sort({ createdAt: 1, _id: 1 })
      .session(session)
      .lean<AccountRow[]>()
      .exec();

    for (const sequence of Object.values(LEDGER_ACCOUNT_CODE_SEQUENCES)) {
      const highest = Math.max(
        0,
        ...accounts
          .filter((account) => isCanonicalSequenceCode(sequence, account.code))
          .map((account) => parseSequenceCode(sequence, account.code) ?? 0),
      );
      await sequenceService.ensureAtLeast(sequence.key, highest, session);
    }

    const recoded: LedgerAccountCodeBackfillResult['recoded'] = [];
    for (const account of accounts) {
      const sequence = LEDGER_ACCOUNT_CODE_SEQUENCES[account.type];
      if (!sequence || isCanonicalSequenceCode(sequence, account.code)) {
        continue;
      }
      const code = await sequenceService.nextCode(sequence, session);
      // Raw driver update on purpose: `code` is immutable in the schema, and
      // this migration is the one sanctioned place that assigns it after insert.
      await ledgerAccountModel.collection.updateOne(
        { _id: account._id },
        { $set: { code, legacyCode: account.legacyCode ?? account.code } },
        { session },
      );
      recoded.push({ id: account._id.toString(), from: account.code, to: code });
    }

    return { recoded, duplicateNames: findDuplicateNames(accounts) };
  });
}

function findDuplicateNames(accounts: readonly AccountRow[]): string[] {
  const groups = new Map<string, string[]>();
  for (const account of accounts) {
    const key = `${account.type}: ${account.name.trim().toLocaleLowerCase('en')}`;
    groups.set(key, [...(groups.get(key) ?? []), account.code]);
  }
  return [...groups.entries()]
    .filter(([, codes]) => codes.length > 1)
    .map(([key, codes]) => `${key} (${codes.join(', ')})`);
}
