import type { AnyBulkWriteOperation, Model, Types } from 'mongoose';
import type { LocationDocument } from '../modules/location/schemas/location.schema.js';
import { MAX_LOCATION_LEVELS } from '../modules/location/location-hierarchy.js';

export interface LocationAncestorsBackfillResult {
  scanned: number;
  updated: number;
  /** Records left unchanged because their parent chain is broken. */
  skipped: string[];
  /** Records written, but already deeper than the level limit allows. */
  tooDeep: string[];
}

interface LocationLink {
  _id: Types.ObjectId;
  code: string;
  parentId: Types.ObjectId | null;
  ancestors?: Types.ObjectId[];
  depth?: number;
}

/**
 * One-time (but safely re-runnable) step for locations created before the
 * ancestors/depth cache existed: recomputes both from the parentId chain,
 * which is the source of truth, and writes only records that differ.
 *
 * A record whose chain is broken (a missing parent, or a pre-existing cycle)
 * is reported and left untouched rather than guessed at. A record already
 * deeper than the level limit is still written (the cache must match the
 * data) but reported, since the API will refuse to move anything under it.
 */
export async function backfillLocationAncestors(
  locationModel: Model<LocationDocument>,
): Promise<LocationAncestorsBackfillResult> {
  const locations: LocationLink[] = await locationModel
    .find()
    .select('code parentId ancestors depth')
    .lean<LocationLink[]>()
    .exec();
  const byId = new Map(locations.map((location) => [location._id.toString(), location]));

  const result: LocationAncestorsBackfillResult = { scanned: locations.length, updated: 0, skipped: [], tooDeep: [] };
  const operations: AnyBulkWriteOperation<LocationDocument>[] = [];

  for (const location of locations) {
    const chain = ancestorChain(location, byId);
    if (typeof chain === 'string') {
      result.skipped.push(`${location.code}: ${chain}`);
      continue;
    }

    if (chain.length + 1 > MAX_LOCATION_LEVELS) {
      result.tooDeep.push(`${location.code}: level ${chain.length + 1} (max ${MAX_LOCATION_LEVELS})`);
    }

    if (sameIds(location.ancestors ?? [], chain) && location.depth === chain.length) {
      continue;
    }
    operations.push({
      updateOne: {
        // Matching parentId too means a concurrent move is never overwritten
        // with a chain computed from stale data.
        filter: { _id: location._id, parentId: location.parentId },
        update: { $set: { ancestors: chain, depth: chain.length } },
      },
    });
  }

  if (operations.length > 0) {
    const write = await locationModel.bulkWrite(operations, { ordered: false });
    result.updated = write.modifiedCount;
  }
  return result;
}

/** Root-first ids above `location`, or a description of why the chain is broken. */
function ancestorChain(location: LocationLink, byId: Map<string, LocationLink>): Types.ObjectId[] | string {
  const chain: Types.ObjectId[] = [];
  const seen = new Set<string>([location._id.toString()]);
  let parentId = location.parentId;

  while (parentId) {
    const key = parentId.toString();
    if (seen.has(key)) {
      return `circular parent chain through ${byId.get(key)?.code ?? key}`;
    }
    const parent = byId.get(key);
    if (!parent) {
      return `parent ${key} does not exist`;
    }
    seen.add(key);
    chain.unshift(parent._id);
    parentId = parent.parentId;
  }
  return chain;
}

function sameIds(left: readonly Types.ObjectId[], right: readonly Types.ObjectId[]): boolean {
  return left.length === right.length && left.every((id, index) => id.equals(right[index]));
}
