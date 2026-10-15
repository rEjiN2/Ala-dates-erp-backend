import type { Model } from 'mongoose';
import type { LocationDocument } from '../modules/location/schemas/location.schema.js';
import type { ProductGroupDocument } from '../modules/product/product-groups/schemas/product-group.schema.js';
import { LOCATION_CODE_SEQUENCES } from '../modules/location/location-code.js';
import { PRODUCT_GROUP_CODE_SEQUENCE } from '../modules/product/product-groups/product-group-code.js';
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
  model: Model<any>;
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
}): Promise<CodeSequenceSyncResult[]> {
  const sources: CodeSource[] = [
    ...Object.values(LOCATION_CODE_SEQUENCES).map((sequence) => ({ sequence, model: deps.locationModel })),
    { sequence: PRODUCT_GROUP_CODE_SEQUENCE, model: deps.productGroupModel },
  ];

  const results: CodeSequenceSyncResult[] = [];
  for (const { sequence, model } of sources) {
    const highestExisting = await highestSuffix(model, sequence);
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
