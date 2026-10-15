import { LocationType } from './schemas/location.schema.js';

/**
 * THE location structure. Every create/update/move check, and the rules
 * endpoint the frontend reads, derive from this map, so reshaping the
 * hierarchy means editing only this object.
 *
 * Each entry lists the types a location may sit under; `null` means it may
 * also be top-level. A type without `null` must have a parent.
 */
export const ALLOWED_PARENT_TYPES: Readonly<Record<LocationType, readonly (LocationType | null)[]>> = {
  [LocationType.BRANCH]: [null, LocationType.BRANCH],
  [LocationType.WAREHOUSE]: [null, LocationType.BRANCH, LocationType.WAREHOUSE, LocationType.STORE, LocationType.VAN],
  [LocationType.STORE]: [null, LocationType.BRANCH, LocationType.WAREHOUSE, LocationType.STORE, LocationType.VAN],
  [LocationType.VAN]: [null, LocationType.BRANCH, LocationType.WAREHOUSE, LocationType.STORE, LocationType.VAN],
};

/** Maximum levels in one chain, counting a top-level location as level 1. */
export const MAX_LOCATION_LEVELS = 6;

/** `depth` is 0 for a top-level location, so the deepest allowed depth is one less than the level count. */
export const MAX_LOCATION_DEPTH = MAX_LOCATION_LEVELS - 1;

export function isParentTypeAllowed(type: LocationType, parentType: LocationType | null): boolean {
  return ALLOWED_PARENT_TYPES[type].includes(parentType);
}

export function describeAllowedParents(type: LocationType): string {
  const allowed = ALLOWED_PARENT_TYPES[type];
  const parents = allowed.filter((parentType): parentType is LocationType => parentType !== null);
  if (parents.length === 0) {
    return `A ${type} must be top-level and cannot have a parent location`;
  }
  const options = parents.join(', ');
  return allowed.includes(null)
    ? `A ${type} must be top-level or sit under one of: ${options}`
    : `A ${type} must sit under one of: ${options}`;
}
