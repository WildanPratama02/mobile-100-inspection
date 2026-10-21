/**
 * What the readiness checks `DB` and `MASTER_DATA` read (doc 02 §10): the newest applied migration and the size of
 * the master tables. The integrity rules of doc 02 §3.5 that the schema cannot hold are counted here too.
 */
import type { Database, Queryable } from '../db/database';

export const READINESS_REPOSITORY = Symbol('ReadinessRepository');

export interface MasterDataCounts {
  activeUsers: number;
  activeCells: number;
  defects: number;
  areas: number;
  activeMapRows: number;
  /** Active defects that no active map row offers: a warning, not a failure (doc 02 §3.5). */
  unmappedDefects: number;
}

export interface ReadinessRepository {
  /** The newest version in `schema_migrations`, `null` when none is applied. */
  latestMigration(q?: Queryable): Promise<string | null>;
  masterDataCounts(q?: Queryable): Promise<MasterDataCounts>;
}

export class PgReadinessRepository implements ReadinessRepository {
  constructor(private readonly db: Database) {}

  async latestMigration(q: Queryable = this.db): Promise<string | null> {
    const { rows } = await q.query<{ version: string | null }>(
      `SELECT max(version) AS version FROM schema_migrations`,
    );
    return rows[0]?.version ?? null;
  }

  async masterDataCounts(q: Queryable = this.db): Promise<MasterDataCounts> {
    // Cells count only under active `F <number>` factories: those are the ones a PSI can log in to.
    const { rows } = await q.query<MasterDataCounts>(
      `SELECT (SELECT count(*) FROM psi_users WHERE active)::int AS "activeUsers",
              (SELECT count(*) FROM cells c JOIN factories f ON f.id = c.factory_id
                WHERE c.active AND f.active AND f.name ~ '^F [0-9]+$')::int AS "activeCells",
              (SELECT count(*) FROM defects)::int AS defects,
              (SELECT count(*) FROM areas)::int AS areas,
              (SELECT count(*) FROM area_map WHERE active)::int AS "activeMapRows",
              (SELECT count(*) FROM defects d WHERE d.active AND NOT EXISTS (
                 SELECT 1 FROM area_map m WHERE m.defect_id = d.id AND m.active))::int AS "unmappedDefects"`,
    );
    return rows[0]!;
  }
}
