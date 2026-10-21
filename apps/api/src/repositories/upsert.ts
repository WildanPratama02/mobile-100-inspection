/**
 * Batched upsert by natural key for the master tables (doc 02 §5.1: the import "upserts by natural key and never
 * deletes"). Rows travel as one array per column through `unnest`, so 34,000 POs need a few statements, not 34,000.
 * `updated_at` is touched only when a value really changes, so a second identical run reports nothing updated.
 */
import type { Queryable } from '../db/database';

export interface UpsertCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface UpsertSpec<R> {
  /** Table and column names are constants of this code base, never input. */
  table: string;
  /** The natural key, a unique constraint of the table. */
  key: readonly string[];
  /** Every column written, with its PostgreSQL array element type, and how to read it from a row. */
  columns: readonly { name: string; type: string; value: (row: R) => unknown }[];
  /** Columns overwritten on conflict; empty means an existing row is left as it is. */
  update: readonly string[];
  /** Columns whose change counts as an update; default `update`. Bookkeeping like `pos.source` is left out. */
  compare?: readonly string[];
}

const CHUNK = 5000;

export const NO_CHANGES: UpsertCounts = { inserted: 0, updated: 0, unchanged: 0 };

export async function upsert<R>(
  q: Queryable,
  spec: UpsertSpec<R>,
  rows: readonly R[],
): Promise<UpsertCounts> {
  const counts = { ...NO_CHANGES };
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const { rows: written } = await q.query<{ inserted: boolean }>(
      upsertSql(spec),
      spec.columns.map((c) => chunk.map(c.value)),
    );
    const inserted = written.filter((r) => r.inserted).length;
    counts.inserted += inserted;
    counts.updated += written.length - inserted;
    counts.unchanged += chunk.length - written.length;
  }
  return counts;
}

function upsertSql<R>({ table, key, columns, update, compare = update }: UpsertSpec<R>): string {
  const names = columns.map((c) => c.name).join(', ');
  const arrays = columns.map((c, i) => `$${i + 1}::${c.type}[]`).join(', ');
  // ROW(...) so that a single compared column is still compared as a row.
  const onConflict =
    update.length === 0
      ? 'DO NOTHING'
      : `DO UPDATE SET ${update.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()
         WHERE ROW(${compare.map((c) => `${table}.${c}`).join(', ')})
               IS DISTINCT FROM ROW(${compare.map((c) => `EXCLUDED.${c}`).join(', ')})`;
  // xmax = 0 only on a row version this statement inserted; an updated row carries the updating transaction's id.
  return `INSERT INTO ${table} (${names})
          SELECT * FROM unnest(${arrays}) AS input (${names})
          ON CONFLICT (${key.join(', ')}) ${onConflict}
          RETURNING (xmax = 0) AS inserted`;
}
