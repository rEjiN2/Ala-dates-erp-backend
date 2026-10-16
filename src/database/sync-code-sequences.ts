import type { Model } from 'mongoose';
import type { LocationDocument } from '../modules/location/schemas/location.schema.js';
import type { ProductGroupDocument } from '../modules/product/product-groups/schemas/product-group.schema.js';
import { LOCATION_CODE_SEQUENCES } from '../modules/location/location-code.js';
import { PRODUCT_GROUP_CODE_SEQUENCE } from '../modules/product/product-groups/product-group-code.js';
import { PARTY_CODE_SEQUENCES } from '../modules/party/party-code.js';
import { CASHIER_CODE_SEQUENCE } from '../modules/cashier/cashier-code.js';
import { CodeSequence, escapeRegExp, parseSequenceCode } from '../modules/sequence/code-sequence.js';
import type { SequenceService } from '../modules/sequence/sequence.service.js';

export interface CodeSequenceSyncResult {
  key: string;
  prefix: string;
  /** Highest suffix found in existing codes for this prefix (0 if none). */
  highestExisting: number;
  /** Counter value after the sync: the next code issued is this + 1. */
  counter: number;
}

interface CodeSource {
  sequence: CodeSequence;
  /** Every collection a code in this sequence can appear in. */
  models: Model<any>[];
}

/**
 * One-time (but safely re-runnable) step for data entered before codes were
 * generated: raises each counter to the highest numeric suffix already used
 * with its prefix, so new codes can never collide with manual ones.
 *
 * Read-only on the records themselves: codes that don't match a prefix's
 * format are left exactly as they are, never renamed. The prefix is matched
 * across the whole collection, not just one type, because the unique index on
 * code is collection-wide (a Warehouse manually coded "BR-0007" still blocks
 * BR-0007 for Branches). Counters are only ever raised ($max), so running this
 * twice, or while the app is creating records, is harmless.
 */
export async function syncCodeSequences(deps: {
  locationModel: Model<LocationDocument>;
  productGroupModel: Model<ProductGroupDocument>;
  sequenceService: SequenceService;
  /**
   * Party codes (CUS-/SUP-) are also the codes of their ledger accounts, and
   * ledger codes are unique, so both collections are scanned: a hand-entered
   * supplier ledger account "SUP-0007" must push the counter past 7.
   */
  partyModel?: Model<any>;
  ledgerAccountModel?: Model<any>;
  cashierModel?: Model<any>;
}): Promise<CodeSequenceSyncResult[]> {
  const partyCodeHolders = [deps.partyModel, deps.ledgerAccountModel].filter((model) => model !== undefined);
  const sources: CodeSource[] = [
    ...Object.values(LOCATION_CODE_SEQUENCES).map((sequence) => ({ sequence, models: [deps.locationModel] })),
    { sequence: PRODUCT_GROUP_CODE_SEQUENCE, models: [deps.productGroupModel] },
    ...(partyCodeHolders.length > 0
      ? Object.values(PARTY_CODE_SEQUENCES).map((sequence) => ({ sequence, models: partyCodeHolders }))
      : []),
    ...(deps.cashierModel ? [{ sequence: CASHIER_CODE_SEQUENCE, models: [deps.cashierModel] }] : []),
  ];

  const results: CodeSequenceSyncResult[] = [];
  for (const { sequence, models } of sources) {
    let highestExisting = 0;
    for (const model of models) {
      highestExisting = Math.max(highestExisting, await highestSuffix(model, sequence));
    }
    const counter = await deps.sequenceService.ensureAtLeast(sequence.key, highestExisting);
    results.push({ key: sequence.key, prefix: sequence.prefix, highestExisting, counter });
  }
  return results;
}

async function highestSuffix(model: Model<any>, sequence: CodeSequence): Promise<number> {
  // The anchored prefix regex narrows the scan to candidate codes (and can use
  // the code index); parseSequenceCode does the exact match.
  const docs: { code: string }[] = await model
    .find({ code: { $regex: `^${escapeRegExp(sequence.prefix)}` } })
    .select('code')
    .lean()
    .exec();

  let highest = 0;
  for (const { code } of docs) {
    const value = parseSequenceCode(sequence, code);
    if (value !== null && value > highest) {
      highest = value;
    }
  }
  return highest;
}
