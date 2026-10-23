/**
 * `audit_log` (doc 02 §5.2–5.3): one row per change by an admin, a script or the system. Written in the transaction
 * of the change it records, so a rolled-back change leaves no row. Never updated or deleted (no grant).
 */
import type { Database, Queryable } from '../db/database';

export const AUDIT_LOG_REPOSITORY = Symbol('AuditLogRepository');

/** `admin:<username>`, `script:<name>` or `system` (checked by the table). */
export type Actor = 'system' | `admin:${string}` | `script:${string}`;

export interface AuditEntry {
  actor: Actor;
  action: string;
  entity: string;
  entityId?: string | null;
  /** Old and new values; stored as jsonb. */
  details?: unknown;
}

export interface AuditRecord extends Required<AuditEntry> {
  /** bigint, as text. */
  id: string;
  at: Date;
}

/** Filters of the admin's audit-log screen (doc 05 §20.6, doc 04 §10 A16); all optional, all apply together. */
export interface AuditFilter {
  /** `YYYY-MM-DD`, inclusive, on the WIB date of `at`. */
  from?: string;
  to?: string;
  /** Exact, e.g. `admin:qip.digital`. */
  actor?: string;
  entity?: string;
  entityId?: string;
}

export interface AuditLogRepository {
  append(entry: AuditEntry, q?: Queryable): Promise<AuditRecord>;
  /** Newest first; `beforeId` continues a previous page. */
  list(options?: { limit?: number; beforeId?: string }, q?: Queryable): Promise<AuditRecord[]>;
  /** One page of the filtered rows, newest first, and how many rows match in all. */
  search(
    filter: AuditFilter,
    page: { offset: number; limit: number },
    q?: Queryable,
  ): Promise<{ total: number; items: AuditRecord[] }>;
}

const COLUMNS = `id::text AS id, at, actor, action, entity, entity_id AS "entityId", details`;

export class PgAuditLogRepository implements AuditLogRepository {
  constructor(private readonly db: Database) {}

  async append(entry: AuditEntry, q: Queryable = this.db): Promise<AuditRecord> {
    const { rows } = await q.query<AuditRecord>(
      `INSERT INTO audit_log (actor, action, entity, entity_id, details) VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [
        entry.actor,
        entry.action,
        entry.entity,
        entry.entityId ?? null,
        entry.details === undefined ? null : JSON.stringify(entry.details),
      ],
    );
    return rows[0]!;
  }

  async list(
    { limit = 100, beforeId }: { limit?: number; beforeId?: string } = {},
    q: Queryable = this.db,
  ): Promise<AuditRecord[]> {
    const { rows } = await q.query<AuditRecord>(
      `SELECT ${COLUMNS} FROM audit_log
        WHERE $1::bigint IS NULL OR id < $1::bigint
        ORDER BY audit_log.id DESC LIMIT $2`,
      [beforeId ?? null, limit],
    );
    return rows;
  }

  async search(
    filter: AuditFilter,
    { offset, limit }: { offset: number; limit: number },
    q: Queryable = this.db,
  ): Promise<{ total: number; items: AuditRecord[] }> {
    const params: unknown[] = [];
    const clauses: string[] = [];
    const add = (value: string | undefined, clause: (p: string) => string) => {
      if (value === undefined) return;
      params.push(value);
      clauses.push(clause(`$${params.length}`));
    };
    // A WIB day, as a range of `at`, so the comparison does not depend on the session time zone.
    add(filter.from, (p) => `at >= (${p}::date::timestamp AT TIME ZONE 'Asia/Jakarta')`);
    add(filter.to, (p) => `at < ((${p}::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta')`);
    add(filter.actor, (p) => `actor = ${p}`);
    add(filter.entity, (p) => `entity = ${p}`);
    add(filter.entityId, (p) => `entity_id = ${p}`);
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = await q.query<{ n: number }>(
      `SELECT count(*)::integer AS n FROM audit_log ${whereSql}`,
      params,
    );
    const { rows } = await q.query<AuditRecord>(
      `SELECT ${COLUMNS} FROM audit_log ${whereSql}
        ORDER BY audit_log.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { total: total.rows[0]!.n, items: rows };
  }
}
