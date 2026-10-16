import { round2 } from './money.util.js';

const ONES = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const SCALES = ['', 'Thousand', 'Million', 'Billion', 'Trillion'];

export interface CurrencyWords {
  /** Name of the main unit, plural, e.g. "UAE Dirhams". */
  major: string;
  /** Name of the hundredth unit, e.g. "Fils". */
  minor: string;
}

export const AED_WORDS: CurrencyWords = { major: 'UAE Dirhams', minor: 'Fils' };

/**
 * Cheque-style amount in English, rounded to 2 decimals:
 *   12345.67 -> "UAE Dirhams Twelve Thousand Three Hundred Forty-Five and Sixty-Seven Fils Only"
 *   1        -> "UAE Dirhams One Only"
 *   0.5      -> "UAE Dirhams Zero and Fifty Fils Only"
 * The fils clause is left out when there are no fils.
 */
export function amountInWords(amount: number, currency: CurrencyWords = AED_WORDS): string {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError(`Cannot write ${amount} in words: expected a finite, non-negative amount`);
  }

  // Whole fils as an integer, so the split below has no float error.
  const totalFils = Math.round(round2(amount) * 100);
  const units = Math.floor(totalFils / 100);
  const fils = totalFils % 100;

  const filsClause = fils > 0 ? ` and ${integerInWords(fils)} ${currency.minor}` : '';
  return `${currency.major} ${integerInWords(units)}${filsClause} Only`;
}

/** Non-negative integer in English words, short scale ("Million", "Billion"). */
export function integerInWords(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Cannot write ${value} in words: expected a non-negative safe integer`);
  }
  if (value === 0) {
    return ONES[0];
  }

  const groups: string[] = [];
  let remaining = value;
  for (let scale = 0; remaining > 0; scale++) {
    const group = remaining % 1000;
    if (group > 0) {
      if (scale >= SCALES.length) {
        throw new RangeError(`Cannot write ${value} in words: too large`);
      }
      groups.unshift([underThousand(group), SCALES[scale]].filter(Boolean).join(' '));
    }
    remaining = Math.floor(remaining / 1000);
  }
  return groups.join(' ');
}

function underThousand(value: number): string {
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  const parts: string[] = [];
  if (hundreds > 0) {
    parts.push(`${ONES[hundreds]} Hundred`);
  }
  if (rest > 0) {
    parts.push(
      rest < 20
        ? ONES[rest]
        : [TENS[Math.floor(rest / 10)], rest % 10 ? ONES[rest % 10] : ''].filter(Boolean).join('-'),
    );
  }
  return parts.join(' ');
}
