/** Screen formats of the admin app: the shared id-ID and WIB formatters (CLAUDE.md UI rules). */
import { NO_VALUE, formatDateTime, formatRate, inspectionDate } from '@m100/shared';

export { NO_VALUE, formatCount, formatDate } from '@m100/shared';

/** A rate of a submission; "—" when Qty Inspection is 0 (BR-02). */
export function rate(value: number, qtyInspection: number): string {
  return formatRate(qtyInspection === 0 ? null : value);
}

/** A moment as `19 Okt 2026 14.05 WIB`; empty → "—". */
export function moment(at: string | null | undefined): string {
  if (!at) return NO_VALUE;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? NO_VALUE : formatDateTime(date);
}

/** Today's WIB date `YYYY-MM-DD`: the default of the date filters (doc 05 §20.3). */
export function todayWib(now: Date = new Date()): string {
  return inspectionDate(now);
}

/** `admin:qip.digital` → `qip.digital`; `script:import-master` and `system` stay as they are. */
export function actorName(actor: string): string {
  return actor.startsWith('admin:') ? actor.slice('admin:'.length) : actor;
}

function value(v: unknown): string {
  if (v === null || v === undefined || v === '') return NO_VALUE;
  if (typeof v === 'boolean') return v ? 'ya' : 'tidak';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return v.toString();
  return JSON.stringify(v) ?? NO_VALUE;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * One line from an audit row's `details` (doc 04 §10 A16): changed fields as `field: old → new`, a new row's fields
 * as `field: value`, anything else as `key: value` pairs.
 */
export function auditSummary(details: unknown): string {
  if (!isRecord(details)) return details === null || details === undefined ? '' : value(details);
  const { old: before, new: after, ...rest } = details;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(rest)) parts.push(`${k}: ${value(v)}`);
  if (isRecord(after)) {
    for (const [k, v] of Object.entries(after)) {
      parts.push(
        isRecord(before) && k in before
          ? `${k}: ${value(before[k])} → ${value(v)}`
          : `${k}: ${value(v)}`,
      );
    }
  }
  return parts.join('; ');
}
