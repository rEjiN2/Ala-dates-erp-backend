import type { CodeSequence } from '../sequence/code-sequence.js';
import { LocationType } from './schemas/location.schema.js';

/** One counter per location type, e.g. BR-0001, WH-0001, ST-0001, VAN-0001. */
export const LOCATION_CODE_SEQUENCES: Record<LocationType, CodeSequence> = {
  [LocationType.BRANCH]: { key: 'location:branch', prefix: 'BR-', width: 4 },
  [LocationType.WAREHOUSE]: { key: 'location:warehouse', prefix: 'WH-', width: 4 },
  [LocationType.STORE]: { key: 'location:store', prefix: 'ST-', width: 4 },
  [LocationType.VAN]: { key: 'location:van', prefix: 'VAN-', width: 4 },
};
