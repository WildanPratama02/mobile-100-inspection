/** Number and date formats for the screen (doc 05 G5): id-ID, rates with one decimal. */
import type { PoPartial } from './domain';

const COUNT = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const RATE = new Intl.NumberFormat('id-ID', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
// PO dates are calendar days without a time; reading and showing them in UTC never shifts a day.
const DATE = new Intl.DateTimeFormat('id-ID', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
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

/** PO PARTIAL on Home and in Submit PO: `P1 · 1.200 dari 10.002` (doc 05 §15). */
export function formatPartial(partial: PoPartial, orderQty: number): string {
  return `P${partial.number} · ${formatCount(partial.qty)} dari ${formatCount(orderQty)}`;
}

/** A PO date `YYYY-MM-DD` as `dd MMM yyyy` (`16 Okt 2026`, doc 05 §9.1); empty or unreadable → `-`. */
export function formatDate(date: string | null): string {
  const match = date === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return '-';
  const [y, m, d] = match.slice(1).map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  if (at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return '-';
  return DATE.format(at);
}

// Moments are shown in WIB, whatever time zone the tablet is set to (CLAUDE.md).
const WIB = 'Asia/Jakarta';
const WIB_TEXT = new Intl.DateTimeFormat('id-ID', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: WIB,
});
const WIB_DIGITS = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: WIB,
});

function parts(format: Intl.DateTimeFormat, at: Date): Partial<Record<string, string>> {
  return Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
}

/** A moment as `19 Okt 2026 14.05 WIB` (export time, AC-12.1). */
export function formatDateTime(at: Date): string {
  const p = parts(WIB_TEXT, at);
  return `${p.day} ${p.month} ${p.year} ${p.hour}.${p.minute} WIB`;
}

/** The WIB calendar day of a moment as `YYYYMMDD`, for export file names (AC-12.3). */
export function fileDate(at: Date): string {
  const p = parts(WIB_DIGITS, at);
  return `${p.year}${p.month}${p.day}`;
}
