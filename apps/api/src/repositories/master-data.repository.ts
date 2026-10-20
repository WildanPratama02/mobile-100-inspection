/**
 * Master data (doc 02 §3): PSI users, factories and cells, defects and the area map. Reads serve `/master-data`,
 * login (doc 04 §3.1) and the submission checks (doc 04 §4.2); writes serve the import (doc 02 §5.1) and the admin app
 * (doc 02 §5.2). Rows are deactivated, never deleted. Callers that change what tablets download bump
 * `settings.master_version` in the same transaction (`SettingsRepository.bumpMasterVersion`).
 */
import type {
  Area,
  AreaId,
  AreaMapRow,
  Cell,
  Classification,
  DefectId,
  Factory,
  Family,
  PsiLevel,
  User,
} from '@m100/shared';
import type { Database, Queryable } from '../db/database';
import { NO_CHANGES, upsert, type UpsertCounts } from './upsert';

export const MASTER_DATA_REPOSITORY = Symbol('MasterDataRepository');

export interface MasterDefect {
  id: DefectId;
  /** Exactly as imported; D049 and D071 share a name (ADR-009). */
  name: string;
  classification: Classification;
  ctqCategory: string | null;
  ctqCode: string | null;
  active: boolean;
}

export interface SubAreaRef {
  id: string;
  areaId: AreaId;
  active: boolean;
}

export interface MapRowRef extends AreaMapRow {
  active: boolean;
}

export type DefectInput = Omit<MasterDefect, 'active'>;
export interface CellInput {
  code: string;
  factory: string;
}
export interface AreaInput {
  id: AreaId;
  name: string;
  sort: number;
}
export interface SubAreaInput {
  id: string;
  areaId: AreaId;
  name: string;
  sort: number;
}
export type AreaMapInput = AreaMapRow;

/** Master tables whose rows can be deactivated and reactivated, with their key column. */
export const MASTER_ENTITIES = {
  psi_users: 'id',
  factories: 'id',
  cells: 'id',
  pos: 'po',
  defects: 'id',
  areas: 'id',
  sub_areas: 'id',
  families: 'id',
  area_map: 'id',
} as const;
export type MasterEntity = keyof typeof MASTER_ENTITIES;

export interface MasterDataRepository {
  /** Active (username, level) pairs, by name then level. */
  activeUsers(q?: Queryable): Promise<User[]>;
  /** Active factories of the form `F <number>` with their active cells, both in the order they were added. */
  activeFactories(q?: Queryable): Promise<Factory[]>;
  /** Active areas by `sort`, each with its active sub-areas by `sort`. */
  activeAreas(q?: Queryable): Promise<Area[]>;
  activeFamilies(q?: Queryable): Promise<Family[]>;
  activeDefects(q?: Queryable): Promise<MasterDefect[]>;
  /** Active map rows whose area, sub-area, family and defect are active too. */
  activeAreaMap(q?: Queryable): Promise<AreaMapRow[]>;

  findActiveUser(username: string, level: PsiLevel, q?: Queryable): Promise<User | null>;
  /** The cell when it and its factory are both active and it belongs to that factory. */
  findActiveCell(factory: string, cell: string, q?: Queryable): Promise<Cell | null>;
  /** Defects by id, active or not; ids that do not exist are missing from the result. */
  findDefects(ids: readonly string[], q?: Queryable): Promise<MasterDefect[]>;
  findSubAreas(ids: readonly string[], q?: Queryable): Promise<SubAreaRef[]>;
  /**
   * Map rows, active or not, for (sub-area, defect) pairs: a finding stays valid when its map row was deactivated
   * after the PSI tapped it (doc 04 §4.2 rule 4).
   */
  findMapRows(
    pairs: readonly { subAreaId: string; defectId: string }[],
    q?: Queryable,
  ): Promise<MapRowRef[]>;

  // Upserts by natural key; `active` of an existing row is left as an admin set it.
  upsertUsers(rows: readonly User[], q?: Queryable): Promise<UpsertCounts>;
  upsertFactories(names: readonly string[], q?: Queryable): Promise<UpsertCounts>;
  /** Every cell's factory must exist. */
  upsertCells(rows: readonly CellInput[], q?: Queryable): Promise<UpsertCounts>;
  upsertDefects(rows: readonly DefectInput[], q?: Queryable): Promise<UpsertCounts>;
  upsertAreas(rows: readonly AreaInput[], q?: Queryable): Promise<UpsertCounts>;
  upsertSubAreas(rows: readonly SubAreaInput[], q?: Queryable): Promise<UpsertCounts>;
  upsertFamilies(rows: readonly Family[], q?: Queryable): Promise<UpsertCounts>;
  upsertAreaMap(rows: readonly AreaMapInput[], q?: Queryable): Promise<UpsertCounts>;

  /** Deactivates or reactivates one row; `false` when no row has that key. */
  setActive(
    entity: MasterEntity,
    key: string | number,
    active: boolean,
    q?: Queryable,
  ): Promise<boolean>;
}

const FACTORY_NAME = '^F [0-9]+$';

const DEFECT_SELECT = `SELECT id, name, severity AS classification, ctq_category AS "ctqCategory",
                              ctq_code AS "ctqCode", active
                         FROM defects`;

export class PgMasterDataRepository implements MasterDataRepository {
  constructor(private readonly db: Database) {}

  async activeUsers(q: Queryable = this.db): Promise<User[]> {
    const { rows } = await q.query<User>(
      `SELECT username, level FROM psi_users WHERE active ORDER BY username, level`,
    );
    return rows;
  }

  async activeFactories(q: Queryable = this.db): Promise<Factory[]> {
    const { rows } = await q.query<Factory>(
      `SELECT f.name AS factory,
              coalesce(array_agg(c.code ORDER BY c.id) FILTER (WHERE c.id IS NOT NULL), '{}') AS cells
         FROM factories f
         LEFT JOIN cells c ON c.factory_id = f.id AND c.active
        WHERE f.active AND f.name ~ $1
        GROUP BY f.id
        ORDER BY f.id`,
      [FACTORY_NAME],
    );
    return rows;
  }

  async activeAreas(q: Queryable = this.db): Promise<Area[]> {
    const { rows } = await q.query<Area>(
      `SELECT a.id, a.name, a.sort AS "order",
              coalesce(json_agg(json_build_object('id', s.id, 'name', s.name, 'order', s.sort)
                                ORDER BY s.sort, s.id) FILTER (WHERE s.id IS NOT NULL), '[]') AS "subAreas"
         FROM areas a
         LEFT JOIN sub_areas s ON s.area_id = a.id AND s.active
        WHERE a.active
        GROUP BY a.id
        ORDER BY a.sort, a.id`,
    );
    return rows;
  }

  async activeFamilies(q: Queryable = this.db): Promise<Family[]> {
    const { rows } = await q.query<Family>(
      `SELECT id, name FROM families WHERE active ORDER BY id`,
    );
    return rows;
  }

  async activeDefects(q: Queryable = this.db): Promise<MasterDefect[]> {
    const { rows } = await q.query<MasterDefect>(`${DEFECT_SELECT} WHERE active ORDER BY id`);
    return rows;
  }

  async activeAreaMap(q: Queryable = this.db): Promise<AreaMapRow[]> {
    const { rows } = await q.query<AreaMapRow>(
      `SELECT m.id AS "mapId", m.area_id AS "areaId", m.sub_area_id AS "subAreaId",
              m.family_id AS "familyId", m.defect_id AS "defectId"
         FROM area_map m
         JOIN areas a ON a.id = m.area_id AND a.active
         JOIN sub_areas s ON s.id = m.sub_area_id AND s.active
         JOIN families f ON f.id = m.family_id AND f.active
         JOIN defects d ON d.id = m.defect_id AND d.active
        WHERE m.active
        ORDER BY m.id`,
    );
    return rows;
  }

  async findActiveUser(
    username: string,
    level: PsiLevel,
    q: Queryable = this.db,
  ): Promise<User | null> {
    const { rows } = await q.query<User>(
      `SELECT username, level FROM psi_users WHERE active AND username = $1 AND level = $2`,
      [username, level],
    );
    return rows[0] ?? null;
  }

  async findActiveCell(
    factory: string,
    cell: string,
    q: Queryable = this.db,
  ): Promise<Cell | null> {
    const { rows } = await q.query<Cell>(
      `SELECT f.name AS factory, c.code AS cell
         FROM cells c JOIN factories f ON f.id = c.factory_id
        WHERE c.active AND f.active AND f.name = $1 AND c.code = $2`,
      [factory, cell],
    );
    return rows[0] ?? null;
  }

  async findDefects(ids: readonly string[], q: Queryable = this.db): Promise<MasterDefect[]> {
    const { rows } = await q.query<MasterDefect>(
      `${DEFECT_SELECT} WHERE id = ANY($1::text[]) ORDER BY id`,
      [ids],
    );
    return rows;
  }

  async findSubAreas(ids: readonly string[], q: Queryable = this.db): Promise<SubAreaRef[]> {
    const { rows } = await q.query<SubAreaRef>(
      `SELECT id, area_id AS "areaId", active FROM sub_areas WHERE id = ANY($1::text[]) ORDER BY id`,
      [ids],
    );
    return rows;
  }

  async findMapRows(
    pairs: readonly { subAreaId: string; defectId: string }[],
    q: Queryable = this.db,
  ): Promise<MapRowRef[]> {
    const { rows } = await q.query<MapRowRef>(
      `SELECT m.id AS "mapId", m.area_id AS "areaId", m.sub_area_id AS "subAreaId",
              m.family_id AS "familyId", m.defect_id AS "defectId", m.active
         FROM area_map m
         JOIN unnest($1::text[], $2::text[]) AS p (sub_area_id, defect_id)
           ON p.sub_area_id = m.sub_area_id AND p.defect_id = m.defect_id
        ORDER BY m.id`,
      [pairs.map((p) => p.subAreaId), pairs.map((p) => p.defectId)],
    );
    return rows;
  }

  upsertUsers(rows: readonly User[], q: Queryable = this.db): Promise<UpsertCounts> {
    return upsert(
      q,
      {
        table: 'psi_users',
        key: ['username', 'level'],
        columns: [
          { name: 'username', type: 'text', value: (r) => r.username },
          { name: 'level', type: 'text', value: (r) => r.level },
        ],
        update: [],
      },
      rows,
    );
  }

  upsertFactories(names: readonly string[], q: Queryable = this.db): Promise<UpsertCounts> {
    return upsert(
      q,
      {
        table: 'factories',
        key: ['name'],
        columns: [{ name: 'name', type: 'text', value: (name: string) => name }],
        update: [],
      },
      names,
    );
  }

  async upsertCells(rows: readonly CellInput[], q: Queryable = this.db): Promise<UpsertCounts> {
    if (rows.length === 0) return { ...NO_CHANGES };
    const { rows: factories } = await q.query<{ id: number; name: string }>(
      `SELECT id, name FROM factories WHERE name = ANY($1::text[])`,
      [[...new Set(rows.map((r) => r.factory))]],
    );
    const idOf = new Map(factories.map((f) => [f.name, f.id]));
    const missing = [...new Set(rows.map((r) => r.factory))].filter((name) => !idOf.has(name));
    if (missing.length > 0) throw new Error(`Unknown factories for cells: ${missing.join(', ')}`);
    return upsert(
      q,
      {
        table: 'cells',
        key: ['code'],
        columns: [
          { name: 'code', type: 'text', value: (r) => r.code },
          { name: 'factory_id', type: 'integer', value: (r) => idOf.get(r.factory) },
        ],
        update: ['factory_id'],
      },
      rows,
    );
  }

  upsertDefects(rows: readonly DefectInput[], q: Queryable = this.db): Promise<UpsertCounts> {
    return upsert(
      q,
      {
        table: 'defects',
        key: ['id'],
        columns: [
          { name: 'id', type: 'text', value: (r) => r.id },
          { name: 'name', type: 'text', value: (r) => r.name },
          { name: 'severity', type: 'text', value: (r) => r.classification },
          { name: 'ctq_category', type: 'text', value: (r) => r.ctqCategory },
          { name: 'ctq_code', type: 'text', value: (r) => r.ctqCode },
        ],
        update: ['name', 'severity', 'ctq_category', 'ctq_code'],
      },
      rows,
    );
  }

  upsertAreas(rows: readonly AreaInput[], q: Queryable = this.db): Promise<UpsertCounts> {
    return upsert(
      q,
      {
        table: 'areas',
        key: ['id'],
        columns: [
          { name: 'id', type: 'text', value: (r) => r.id },
          { name: 'name', type: 'text', value: (r) => r.name },
          { name: 'sort', type: 'integer', value: (r) => r.sort },
        ],
        update: ['name', 'sort'],
      },
      rows,
    );
  }

  upsertSubAreas(rows: readonly SubAreaInput[], q: Queryable = this.db): Promise<UpsertCounts> {
    return upsert(
      q,
      {
        table: 'sub_areas',
        key: ['id'],
        columns: [
          { name: 'id', type: 'text', value: (r) => r.id },
          { name: 'area_id', type: 'text', value: (r) => r.areaId },
          { name: 'name', type: 'text', value: (r) => r.name },
          { name: 'sort', type: 'integer', value: (r) => r.sort },
        ],
        update: ['area_id', 'name', 'sort'],
      },
      rows,
    );
  }

  upsertFamilies(rows: readonly Family[], q: Queryable = this.db): Promise<UpsertCounts> {
    return upsert(
      q,
      {
        table: 'families',
        key: ['id'],
        columns: [
          { name: 'id', type: 'text', value: (r) => r.id },
          { name: 'name', type: 'text', value: (r) => r.name },
        ],
        update: ['name'],
      },
      rows,
    );
  }

  upsertAreaMap(rows: readonly AreaMapInput[], q: Queryable = this.db): Promise<UpsertCounts> {
    return upsert(
      q,
      {
        table: 'area_map',
        key: ['id'],
        columns: [
          { name: 'id', type: 'text', value: (r) => r.mapId },
          { name: 'area_id', type: 'text', value: (r) => r.areaId },
          { name: 'sub_area_id', type: 'text', value: (r) => r.subAreaId },
          { name: 'family_id', type: 'text', value: (r) => r.familyId },
          { name: 'defect_id', type: 'text', value: (r) => r.defectId },
        ],
        update: ['area_id', 'sub_area_id', 'family_id', 'defect_id'],
      },
      rows,
    );
  }

  async setActive(
    entity: MasterEntity,
    key: string | number,
    active: boolean,
    q: Queryable = this.db,
  ): Promise<boolean> {
    // The table name goes into the SQL text, so accept only the known ones.
    if (!Object.hasOwn(MASTER_ENTITIES, entity)) throw new Error(`Not a master table: ${entity}`);
    const column = MASTER_ENTITIES[entity];
    // "found" is true also when the row already had that state.
    const { rows } = await q.query<{ found: boolean }>(
      `WITH changed AS (
         UPDATE ${entity} SET active = $2, updated_at = now() WHERE ${column} = $1 AND active <> $2 RETURNING 1
       )
       SELECT EXISTS (SELECT 1 FROM changed) OR EXISTS (SELECT 1 FROM ${entity} WHERE ${column} = $1) AS found`,
      [key, active],
    );
    return rows[0]?.found === true;
  }
}
