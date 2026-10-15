/**
 * Describes one numbered series: which counter document it draws from and how
 * the number is rendered. Services and the counter-sync migration both read
 * these, so the format a code is issued in and the format the migration scans
 * for can never drift apart.
 */
export interface CodeSequence {
  /** Counter document key in the `counters` collection. */
  key: string;
  /** Literal text before the number, separator included (e.g. "BR-", "CR"). */
  prefix: string;
  /** Minimum digits; zero-padded below it, grows naturally past it. */
  width: number;
}

export function formatSequenceCode(sequence: CodeSequence, value: number): string {
  return `${sequence.prefix}${value.toString().padStart(sequence.width, '0')}`;
}

/**
 * Numeric suffix of a code in this sequence's shape, or null for any other code.
 * Any digit count is accepted (e.g. "BR-7" as well as "BR-0007") so the
 * migration errs on the side of skipping a number rather than reusing one.
 */
export function parseSequenceCode(sequence: CodeSequence, code: string): number | null {
  const match = new RegExp(`^${escapeRegExp(sequence.prefix)}(\\d+)$`).exec(code);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

/** True only for a code exactly as formatSequenceCode would have issued it (e.g. "CASH-0001", not "CASH-001"). */
export function isCanonicalSequenceCode(sequence: CodeSequence, code: string): boolean {
  const value = parseSequenceCode(sequence, code);
  return value !== null && formatSequenceCode(sequence, value) === code;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
