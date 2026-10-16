import { describe, expect, it } from 'vitest';
import { amountInWords, integerInWords } from './amount-in-words.js';

describe('amountInWords', () => {
  it.each([
    [0.5, 'UAE Dirhams Zero and Fifty Fils Only'],
    [1, 'UAE Dirhams One Only'],
    [100, 'UAE Dirhams One Hundred Only'],
    [1000, 'UAE Dirhams One Thousand Only'],
    [1_000_000, 'UAE Dirhams One Million Only'],
    [12_345.67, 'UAE Dirhams Twelve Thousand Three Hundred Forty-Five and Sixty-Seven Fils Only'],
    [0, 'UAE Dirhams Zero Only'],
    [0.01, 'UAE Dirhams Zero and One Fils Only'],
    [19.9, 'UAE Dirhams Nineteen and Ninety Fils Only'],
    [1_000_001.05, 'UAE Dirhams One Million One and Five Fils Only'],
    [2_500_110, 'UAE Dirhams Two Million Five Hundred Thousand One Hundred Ten Only'],
  ])('%d -> %s', (amount, words) => {
    expect(amountInWords(amount)).toBe(words);
  });

  it('rounds to 2 decimals first, carrying into the next dirham', () => {
    expect(amountInWords(10.004)).toBe('UAE Dirhams Ten Only');
    expect(amountInWords(10.005)).toBe('UAE Dirhams Ten and One Fils Only');
    expect(amountInWords(9.999)).toBe('UAE Dirhams Ten Only');
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point.
    expect(amountInWords(0.1 + 0.2)).toBe('UAE Dirhams Zero and Thirty Fils Only');
  });

  it('rejects negative and non-finite amounts', () => {
    expect(() => amountInWords(-1)).toThrow(RangeError);
    expect(() => amountInWords(Number.NaN)).toThrow(RangeError);
    expect(() => amountInWords(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('writes teens, tens and hyphenated compounds', () => {
    expect(integerInWords(11)).toBe('Eleven');
    expect(integerInWords(40)).toBe('Forty');
    expect(integerInWords(99)).toBe('Ninety-Nine');
    expect(integerInWords(101)).toBe('One Hundred One');
    expect(integerInWords(1_010)).toBe('One Thousand Ten');
  });
});
