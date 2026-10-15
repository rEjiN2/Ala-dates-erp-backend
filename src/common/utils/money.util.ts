/**
 * Money is stored as a plain Number, so every derived figure is rounded back
 * to 2dp immediately to stop binary-float drift accumulating across lines.
 */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function sum2(values: readonly number[]): number {
  return round2(values.reduce((total, value) => total + value, 0));
}
