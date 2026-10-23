/**
 * Master data as the admin app keeps it (doc 02 §5.2, doc 04 §8): every row, active or not, and single-row changes
 * inside one transaction. Implemented with the TypeORM entities of `db/entities.ts` (doc 03 §5.1); the imports keep
 * the batched upserts of `MasterDataRepository` / `PoRepository`. Rows are deactivated, never deleted: there is no
 * delete here. A duplicate natural key fails with the database's unique violation (`23505`).
 */
import type { AreaId, Classification, DefectId, PsiLevel } from '@m100/shared';
import type { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';
import type { Queryable } from '../db/database';
import {
  AreaEntity,
  AreaMapEntity,
  CellEntity,
  DefectEntity,
  FactoryEntity,
  FamilyEntity,
  PoEntity,
  PsiUserEntity,
  SubAreaEntity,
} from '../db/entities';
import { type AdminDataSource, queryableOf } from '../db/typeorm';

export const MASTER_ADMIN_REPOSITORY = Symbol('MasterAdminRepository');

export interface AdminPsiUser {
  id: number;
  username: string;
  level: PsiLevel;
  active: boolean;
}

export interface AdminFactory {
  id: number;
  name: string;
  active: boolean;
}

export interface AdminCellRow {
  id: number;
  factoryId: number;
  code: string;
  active: boolean;
}

export interface AdminCell extends AdminCellRow {
  /** Name of the cell's factory. */
  factory: string;
}

export interface AdminPo {
  po: string;
  article: string;
  model: string;
  destination: string;
  orderQty: number;
  podd: string | null;
  crd: string | null;
  finished: boolean | null;
  active: boolean;
  source: string;
}

export interface AdminDefect {
  id: DefectId;
  name: string;
  classification: Classification;
  ctqCategory: string | null;
  ctqCode: string | null;
  active: boolean;
}

export interface AdminArea {
  id: AreaId;
  name: string;
  sort: number;
  active: boolean;
}

export interface AdminSubArea {
  id: string;
  areaId: AreaId;
  name: string;
  sort: number;
  active: boolean;
}

export interface AdminFamily {
  id: string;
  name: string;
  active: boolean;
}

export interface AdminMapRow {
  id: string;
  areaId: AreaId;
  subAreaId: string;
  familyId: string;
  defectId: DefectId;
  active: boolean;
}

export interface AdminAreaMap {
  areas: AdminArea[];
  subAreas: AdminSubArea[];
  families: AdminFamily[];
  rows: AdminMapRow[];
}

/** The tables an admin changes row by row, with the row type and the key of each. */
export interface AdminRows {
  psi_users: AdminPsiUser;
  factories: AdminFactory;
  cells: AdminCellRow;
  pos: AdminPo;
  defects: AdminDefect;
  area_map: AdminMapRow;
}
export type AdminTable = keyof AdminRows;
export type AdminKey<T extends AdminTable> = T extends 'pos'
  ? string
  : AdminRows[T] extends { id: infer K }
    ? K
    : never;
/** An insert: the row without its generated `id`. */
export type AdminInsert<T extends AdminTable> = T extends 'pos'
  ? AdminRows[T]
  : Omit<AdminRows[T], 'id'>;
export type AdminChanges<T extends AdminTable> = Partial<Omit<AdminRows[T], 'id' | 'po'>>;

export const ADMIN_TABLE_KEY = {
  psi_users: 'id',
  factories: 'id',
  cells: 'id',
  pos: 'po',
  defects: 'id',
  area_map: 'id',
} as const satisfies Record<AdminTable, string>;

/** One open transaction. */
export interface MasterAdminTx {
  /** The same transaction for the `pg` repositories: the audit row and the `master_version` bump. */
  q: Queryable;
  /** The row, locked until the end of the transaction; `null` when no row has that key. */
  find<T extends AdminTable>(table: T, key: AdminKey<T>): Promise<AdminRows[T] | null>;
  insert<T extends AdminTable>(table: T, row: AdminInsert<T>): Promise<AdminRows[T]>;
  update<T extends AdminTable>(
    table: T,
    key: AdminKey<T>,
    changes: AdminChanges<T>,
  ): Promise<AdminRows[T]>;
}

export interface MasterAdminRepository {
  transaction<T>(fn: (tx: MasterAdminTx) => Promise<T>): Promise<T>;
  /** By username, then level. */
  psiUsers(): Promise<AdminPsiUser[]>;
  /** In the order they were added. */
  factories(): Promise<AdminFactory[]>;
  /** In the order they were added; only those of `factoryId` when given. */
  cells(factoryId?: number): Promise<AdminCell[]>;
  /** D001–D098. */
  defects(): Promise<AdminDefect[]>;
  /** Areas and sub-areas by `sort`, families and map rows by id. */
  areaMap(): Promise<AdminAreaMap>;
}

const ENTITY: Record<AdminTable, EntityTarget<ObjectLiteral>> = {
  psi_users: PsiUserEntity,
  factories: FactoryEntity,
  cells: CellEntity,
  pos: PoEntity,
  defects: DefectEntity,
  area_map: AreaMapEntity,
};

export class TypeOrmMasterAdminRepository implements MasterAdminRepository {
  constructor(private readonly source: AdminDataSource) {}

  transaction<T>(fn: (tx: MasterAdminTx) => Promise<T>): Promise<T> {
    return this.source.transaction((manager) => fn(new TypeOrmMasterAdminTx(manager)));
  }

  async psiUsers(): Promise<AdminPsiUser[]> {
    const rows = await this.manager().then((m) =>
      m.find(PsiUserEntity, { order: { username: 'ASC', level: 'ASC' } }),
    );
    return rows.map(plain);
  }

  async factories(): Promise<AdminFactory[]> {
    const rows = await this.manager().then((m) => m.find(FactoryEntity, { order: { id: 'ASC' } }));
    return rows.map(plain);
  }

  async cells(factoryId?: number): Promise<AdminCell[]> {
    const m = await this.manager();
    const [cells, factories] = [
      await m.find(CellEntity, {
        where: factoryId === undefined ? {} : { factoryId },
        order: { id: 'ASC' },
      }),
      await m.find(FactoryEntity),
    ];
    const nameOf = new Map(factories.map((f) => [f.id, f.name]));
    return cells.map((c) => ({ ...plain(c), factory: nameOf.get(c.factoryId)! }));
  }

  async defects(): Promise<AdminDefect[]> {
    const rows = await this.manager().then((m) => m.find(DefectEntity, { order: { id: 'ASC' } }));
    return rows.map(plain);
  }

  async areaMap(): Promise<AdminAreaMap> {
    const m = await this.manager();
    return {
      areas: (await m.find(AreaEntity, { order: { sort: 'ASC', id: 'ASC' } })).map(plain),
      subAreas: (
        await m.find(SubAreaEntity, { order: { areaId: 'ASC', sort: 'ASC', id: 'ASC' } })
      ).map(plain),
      families: (await m.find(FamilyEntity, { order: { id: 'ASC' } })).map(plain),
      rows: (await m.find(AreaMapEntity, { order: { id: 'ASC' } })).map(plain),
    };
  }

  private async manager(): Promise<EntityManager> {
    return (await this.source.get()).manager;
  }
}

class TypeOrmMasterAdminTx implements MasterAdminTx {
  readonly q: Queryable;

  constructor(private readonly manager: EntityManager) {
    this.q = queryableOf(manager);
  }

  async find<T extends AdminTable>(table: T, key: AdminKey<T>): Promise<AdminRows[T] | null> {
    const row = await this.manager.findOne(ENTITY[table], {
      where: { [ADMIN_TABLE_KEY[table]]: key },
      lock: { mode: 'pessimistic_write' },
    });
    return row ? (plain(row) as AdminRows[T]) : null;
  }

  async insert<T extends AdminTable>(table: T, row: AdminInsert<T>): Promise<AdminRows[T]> {
    // Copies: TypeORM writes generated columns back into the objects it is given.
    const { identifiers } = await this.manager.insert(ENTITY[table], { ...row });
    const keyColumn = ADMIN_TABLE_KEY[table];
    const key = (identifiers[0]?.[keyColumn] ?? (row as ObjectLiteral)[keyColumn]) as AdminKey<T>;
    return (await this.find(table, key))!;
  }

  async update<T extends AdminTable>(
    table: T,
    key: AdminKey<T>,
    changes: AdminChanges<T>,
  ): Promise<AdminRows[T]> {
    await this.manager.update(ENTITY[table], { [ADMIN_TABLE_KEY[table]]: key }, { ...changes });
    return (await this.find(table, key))!;
  }
}

/** The row as the API sends it: an own-property copy without TypeORM's bookkeeping column. */
function plain<E extends ObjectLiteral>(entity: E): Omit<E, 'updatedAt'> {
  const row: E & { updatedAt?: unknown } = { ...entity };
  delete row.updatedAt;
  return row;
}
