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

export interface AuditLogRepository {
  append(entry: AuditEntry, q?: Queryable): Promise<AuditRecord>;
  /** Newest first; `beforeId` continues a previous page. */
  list(options?: { limit?: number; beforeId?: string }, q?: Queryable): Promise<AuditRecord[]>;
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
        ORDER BY id DESC LIMIT $2`,
      [beforeId ?? null, limit],
    );
    return rows;
  }
}
