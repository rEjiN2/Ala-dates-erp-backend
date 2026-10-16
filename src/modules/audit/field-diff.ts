import { Types } from 'mongoose';
import type { AuditChange } from './schemas/audit-log.schema.js';

export interface DiffField<T> {
  key: keyof T & string;
  label: string;
}

type Plain = string | number | boolean | null;

/**
 * Readable changes between two flat records, in `fields` order. Values are
 * compared after normalising: blank strings and undefined count as null, and
 * strings are trimmed. Pass display values (names, not ids) for references.
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: readonly DiffField<T>[],
): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const { key, label } of fields) {
    const from = normalise(before[key]);
    const to = normalise(after[key]);
    if (from !== to) {
      changes.push({ field: key, label, from, to });
    }
  }
  return changes;
}

function normalise(value: unknown): Plain {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Types.ObjectId) return value.toString();
  return JSON.stringify(value);
}
