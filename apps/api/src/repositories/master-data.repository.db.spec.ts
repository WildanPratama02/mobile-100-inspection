import type { User } from '@m100/shared';
import { Database } from '../db/database';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import {
  type AreaInput,
  type AreaMapInput,
  type CellInput,
  type DefectInput,
  PgMasterDataRepository,
  type SubAreaInput,
} from './master-data.repository';

let db: TestDatabase;
let database: Database;
let repo: PgMasterDataRepository;

const USERS: User[] = [
  { username: 'ROIS FATHUR ROHIM', level: 'PSI lv.2' },
  { username: 'AZIZAH', level: 'PSI lv.2' },
  { username: 'ROIS FATHUR ROHIM', level: 'PSI lv.1' },
];
const FACTORIES = ['F 3', 'F 1', 'PWA', 'BOTTOM'];
const CELLS: CellInput[] = [
  { code: 'F3-10', factory: 'F 3' },
  { code: 'F3-2', factory: 'F 3' },
  { code: 'F1-01', factory: 'F 1' },
  { code: 'PWA-1', factory: 'PWA' },
];
const AREAS: AreaInput[] = [
  { id: 'A02', name: 'VAMP', sort: 2 },
  { id: 'A01', name: 'TOE', sort: 1 },
];
const SUB_AREAS: SubAreaInput[] = [
  { id: 'SA01B', areaId: 'A01', name: 'TOE SIDE', sort: 2 },
  { id: 'SA01A', areaId: 'A01', name: 'TOE TIP', sort: 1 },
  { id: 'SA02A', areaId: 'A02', name: 'VAMP CENTER', sort: 3 },
];
const FAMILIES = [
  { id: 'F01', name: 'BONDING' },
  { id: 'F02', name: 'FINISHING' },
];
/** D049 and D071 share a name and stay two defects (ADR-009). */
const DEFECTS: DefectInput[] = [
  { id: 'D006', name: 'DIRTY (Stain)', classification: 'MINOR', ctqCategory: null, ctqCode: null },
  {
    id: 'D049',
    name: 'POOR TOUCH UP/PAINTING, MARKING LINE',
    classification: 'MINOR',
    ctqCategory: 'Outer carton',
    ctqCode: 'C12',
  },
  {
    id: 'D071',
    name: 'POOR TOUCH UP/PAINTING, MARKING LINE',
    classification: 'MINOR',
    ctqCategory: null,
    ctqCode: null,
  },
];
const MAP: AreaMapInput[] = [
  { mapId: 'MAP-006-01', areaId: 'A01', subAreaId: 'SA01A', familyId: 'F02', defectId: 'D006' },
  { mapId: 'MAP-049-01', areaId: 'A01', subAreaId: 'SA01A', familyId: 'F02', defectId: 'D049' },
  { mapId: 'MAP-071-02', areaId: 'A02', subAreaId: 'SA02A', familyId: 'F02', defectId: 'D071' },
  { mapId: 'MAP-006-02', areaId: 'A02', subAreaId: 'SA02A', familyId: 'F01', defectId: 'D006' },
];

/** The import order of doc 02 §5.1, in one transaction. */
async function importAll() {
  return database.transaction(async (tx) => ({
    users: await repo.upsertUsers(USERS, tx),
    factories: await repo.upsertFactories(FACTORIES, tx),
    cells: await repo.upsertCells(CELLS, tx),
    defects: await repo.upsertDefects(DEFECTS, tx),
    areas: await repo.upsertAreas(AREAS, tx),
    subAreas: await repo.upsertSubAreas(SUB_AREAS, tx),
    families: await repo.upsertFamilies(FAMILIES, tx),
    map: await repo.upsertAreaMap(MAP, tx),
  }));
}

const updatedAt = async (table: string, column: string, key: string): Promise<Date> =>
  (
    await db.client.query<{ at: Date }>(
      `SELECT updated_at AS at FROM ${table} WHERE ${column} = $1`,
      [key],
    )
  ).rows[0]!.at;

beforeAll(async () => {
  db = await createTestDatabase({ migrated: true });
  database = new Database(db.pool('m100_app'));
  repo = new PgMasterDataRepository(database);
});
afterAll(async () => {
  await db?.drop();
});

describe('PgMasterDataRepository upserts (doc 02 §5.1)', () => {
  it('inserts every row on the first run', async () => {
    const counts = await importAll();
    const inserted = (n: number) => ({ inserted: n, updated: 0, unchanged: 0 });
    expect(counts).toEqual({
      users: inserted(3),
      factories: inserted(4),
      cells: inserted(4),
      defects: inserted(3),
      areas: inserted(2),
      subAreas: inserted(3),
      families: inserted(2),
      map: inserted(4),
    });
  });

  it('changes nothing on a second identical run, not even updated_at', async () => {
    const before = await updatedAt('defects', 'id', 'D049');
    const counts = await importAll();
    for (const [table, c] of Object.entries(counts)) {
      expect({ table, inserted: c.inserted, updated: c.updated }).toEqual({
        table,
        inserted: 0,
        updated: 0,
      });
    }
    expect(counts.map.unchanged).toBe(MAP.length);
    expect(await updatedAt('defects', 'id', 'D049')).toEqual(before);
  });

  it('updates a changed row and touches its updated_at only', async () => {
    const before = await updatedAt('defects', 'id', 'D006');
    const counts = await repo.upsertDefects([
      { ...DEFECTS[0]!, classification: 'MAJOR' },
      ...DEFECTS.slice(1),
    ]);
    expect(counts).toEqual({ inserted: 0, updated: 1, unchanged: 2 });
    expect((await repo.findDefects(['D006']))[0]!.classification).toBe('MAJOR');
    expect((await updatedAt('defects', 'id', 'D006')).getTime()).toBeGreaterThan(before.getTime());
    await repo.upsertDefects(DEFECTS);
  });

  it('moves a cell to another factory', async () => {
    expect(await repo.upsertCells([{ code: 'F3-2', factory: 'F 1' }])).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
    });
    expect(await repo.findActiveCell('F 1', 'F3-2')).toEqual({ factory: 'F 1', cell: 'F3-2' });
    await repo.upsertCells(CELLS);
  });

  it('refuses cells of an unknown factory and writes none of them', async () => {
    await expect(
      repo.upsertCells([
        { code: 'F9-01', factory: 'F 9' },
        { code: 'F3-11', factory: 'F 3' },
      ]),
    ).rejects.toThrow('Unknown factories for cells: F 9');
    expect(await repo.findActiveCell('F 3', 'F3-11')).toBeNull();
  });

  it('keeps an admin’s deactivation when the same row is imported again', async () => {
    expect(await repo.setActive('psi_users', await userId('AZIZAH', 'PSI lv.2'), false)).toBe(true);
    await repo.upsertUsers(USERS);
    expect(await repo.findActiveUser('AZIZAH', 'PSI lv.2')).toBeNull();
    await repo.setActive('psi_users', await userId('AZIZAH', 'PSI lv.2'), true);
  });
});

async function userId(username: string, level: string): Promise<number> {
  const { rows } = await db.client.query<{ id: number }>(
    'SELECT id FROM psi_users WHERE username = $1 AND level = $2',
    [username, level],
  );
  return rows[0]!.id;
}

describe('PgMasterDataRepository reads', () => {
  it('lists the active users by name, a name at both levels twice', async () => {
    expect(await repo.activeUsers()).toEqual([
      { username: 'AZIZAH', level: 'PSI lv.2' },
      { username: 'ROIS FATHUR ROHIM', level: 'PSI lv.1' },
      { username: 'ROIS FATHUR ROHIM', level: 'PSI lv.2' },
    ]);
  });

  it('lists only F <number> factories, with their active cells, in the order they were added', async () => {
    expect(await repo.activeFactories()).toEqual([
      { factory: 'F 3', cells: ['F3-10', 'F3-2'] },
      { factory: 'F 1', cells: ['F1-01'] },
    ]);
  });

  it('lists areas and sub-areas by sort order', async () => {
    expect(await repo.activeAreas()).toEqual([
      {
        id: 'A01',
        name: 'TOE',
        order: 1,
        subAreas: [
          { id: 'SA01A', name: 'TOE TIP', order: 1 },
          { id: 'SA01B', name: 'TOE SIDE', order: 2 },
        ],
      },
      {
        id: 'A02',
        name: 'VAMP',
        order: 2,
        subAreas: [{ id: 'SA02A', name: 'VAMP CENTER', order: 3 }],
      },
    ]);
    expect(await repo.activeFamilies()).toEqual(FAMILIES);
  });

  it('keeps D049 and D071 as two defects with the same name', async () => {
    const defects = await repo.activeDefects();
    expect(defects.map((d) => d.id)).toEqual(['D006', 'D049', 'D071']);
    expect(defects[1]).toEqual({ ...DEFECTS[1], active: true });
    expect(defects[1]!.name).toBe(defects[2]!.name);
  });

  it('lists the active area map', async () => {
    expect(await repo.activeAreaMap()).toEqual(
      [...MAP].sort((a, b) => a.mapId.localeCompare(b.mapId)),
    );
  });

  it('finds an active user and an active cell of its own factory only', async () => {
    expect(await repo.findActiveUser('AZIZAH', 'PSI lv.2')).toEqual({
      username: 'AZIZAH',
      level: 'PSI lv.2',
    });
    expect(await repo.findActiveUser('AZIZAH', 'PSI lv.1')).toBeNull();
    expect(await repo.findActiveCell('F 3', 'F3-10')).toEqual({ factory: 'F 3', cell: 'F3-10' });
    expect(await repo.findActiveCell('F 1', 'F3-10')).toBeNull();
    expect(await repo.findActiveCell('F 3', 'F3-99')).toBeNull();
  });

  it('finds defects, sub-areas and map rows by id; unknown ids are simply missing', async () => {
    expect((await repo.findDefects(['D071', 'D999'])).map((d) => d.id)).toEqual(['D071']);
    expect(await repo.findSubAreas(['SA02A', 'SA99'])).toEqual([
      { id: 'SA02A', areaId: 'A02', active: true },
    ]);
    expect(
      await repo.findMapRows([
        { subAreaId: 'SA01A', defectId: 'D049' },
        { subAreaId: 'SA02A', defectId: 'D049' },
      ]),
    ).toEqual([{ ...MAP[1], active: true }]);
  });
});

describe('PgMasterDataRepository.setActive (doc 02 §3: deactivated, never deleted)', () => {
  afterEach(async () => {
    for (const [entity, key] of [
      ['cells', await cellId('F3-2')],
      ['area_map', 'MAP-049-01'],
      ['defects', 'D071'],
      ['factories', await factoryId('F 1')],
    ] as const) {
      await repo.setActive(entity, key, true);
    }
  });

  async function cellId(code: string): Promise<number> {
    return (await db.client.query<{ id: number }>('SELECT id FROM cells WHERE code = $1', [code]))
      .rows[0]!.id;
  }
  async function factoryId(name: string): Promise<number> {
    return (
      await db.client.query<{ id: number }>('SELECT id FROM factories WHERE name = $1', [name])
    ).rows[0]!.id;
  }

  it('hides a deactivated cell from login but keeps the row', async () => {
    expect(await repo.setActive('cells', await cellId('F3-2'), false)).toBe(true);
    expect((await repo.activeFactories())[0]).toEqual({ factory: 'F 3', cells: ['F3-10'] });
    expect(await repo.findActiveCell('F 3', 'F3-2')).toBeNull();
    expect((await db.client.query(`SELECT 1 FROM cells WHERE code = 'F3-2'`)).rowCount).toBe(1);
  });

  it('hides the cells of a deactivated factory', async () => {
    await repo.setActive('factories', await factoryId('F 1'), false);
    expect((await repo.activeFactories()).map((f) => f.factory)).toEqual(['F 3']);
    expect(await repo.findActiveCell('F 1', 'F1-01')).toBeNull();
  });

  it('drops a deactivated map row from the active map, but a finding can still find it', async () => {
    await repo.setActive('area_map', 'MAP-049-01', false);
    expect((await repo.activeAreaMap()).map((m) => m.mapId)).not.toContain('MAP-049-01');
    expect(await repo.findMapRows([{ subAreaId: 'SA01A', defectId: 'D049' }])).toEqual([
      { ...MAP[1], active: false },
    ]);
  });

  it('drops the map rows of a deactivated defect; the defect stays findable by id', async () => {
    await repo.setActive('defects', 'D071', false);
    expect((await repo.activeDefects()).map((d) => d.id)).toEqual(['D006', 'D049']);
    expect((await repo.activeAreaMap()).map((m) => m.defectId)).not.toContain('D071');
    expect((await repo.findDefects(['D071']))[0]!.active).toBe(false);
  });

  it('reports an unknown key, and treats an unchanged state as found', async () => {
    expect(await repo.setActive('defects', 'D098', false)).toBe(false);
    expect(await repo.setActive('defects', 'D006', true)).toBe(true);
  });

  it('refuses a table that is not master data', async () => {
    await expect(repo.setActive('submissions' as never, 'x', false)).rejects.toThrow(
      'Not a master table: submissions',
    );
  });

  it('bumps nothing by itself: the caller bumps master_version in the same transaction', async () => {
    await repo.setActive('defects', 'D071', false);
    const { rows } = await db.client.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'master_version'`,
    );
    expect(rows[0]!.value).toBe('0');
  });
});
