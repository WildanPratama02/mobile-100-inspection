/** Number formats for the screen (doc 05 G5): id-ID, rates with one decimal. */

const COUNT = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const RATE = new Intl.NumberFormat('id-ID', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Shown for a rate that can't be computed (Qty Inspection is 0). */
export const NO_VALUE = '—';

/** `2400` → `2.400`. */
export function formatCount(n: number): string {
  return COUNT.format(n);
}

/** `0.1875` → `18,8%`; `null` → `—` (BR-02, FR-04). */
export function formatRate(rate: number | null): string {
  return rate === null ? NO_VALUE : RATE.format(rate);
}
