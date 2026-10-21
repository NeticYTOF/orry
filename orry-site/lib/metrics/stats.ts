/* Upper median and p90, as the bot computes them (PLAN 5.1; lib/ticketMetrics.ts:79-83). Pure. */

/** The minimum sample for any median or p90, everywhere (PLAN 4.0, 5.1). */
export const MIN_N = 5;

/** Drops lags below 0 and non-finite values, then sorts ascending. */
export function usable(values: Array<number | null | undefined>): number[] {
  return values.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
}

/** Upper median: sorted[floor(n/2)]. null when empty. No n-minimum (use `summary` for display numbers). */
export function upperMedian(values: Array<number | null | undefined>): number | null {
  const s = usable(values);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

/** p90: sorted[ceil(0.9 × n) − 1]. */
export function p90(values: Array<number | null | undefined>): number | null {
  const s = usable(values);
  return s.length ? s[Math.ceil(0.9 * s.length) - 1] : null;
}

export type Summary = { n: number; median: number | null; p90: number | null; tooFew: boolean };

/** Median and p90 with the n-minimum: both null and `tooFew` when n < MIN_N. */
export function summary(values: Array<number | null | undefined>, minN = MIN_N): Summary {
  const s = usable(values);
  if (s.length < minN) return { n: s.length, median: null, p90: null, tooFew: true };
  return { n: s.length, median: s[Math.floor(s.length / 2)], p90: s[Math.ceil(0.9 * s.length) - 1], tooFew: false };
}

/** Rounded percent; null when the denominator is 0. */
export const pct = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 100) : null);
