import { Database } from '../db/database';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { FIXTURE_PO_EXPECTED, fixtureTables } from '../testing/master-fixtures';
import {
  IMPORT_ACTOR,
  importMaster,
  type ImportRepositories,
  pgImportRepositories,
} from './import-master';
import { ImportInvalid, type ParsedMaster, parseMaster } from './parse-master';

let testDb: TestDatabase;
let db: Database;
let repos: ImportRepositories;
let parsed: ParsedMaster;

const MASTER_TABLES = [
  'psi_users',
  'factories',
  'cells',
  'defects',
  'areas',
  'sub_areas',
  'families',
  'area_map',
  'pos',
] as const;

/** Row count and newest `updated_at` of every master table, plus `master_version`: equal means nothing changed. */
async function snapshot(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of MASTER_TABLES) {
    const { rows } = await testDb.client.query<{ n: string; at: Date | null }>(
      `SELECT count(*)::text AS n, max(updated_at) AS at FROM ${table}`,
    );
    result[table] = `${rows[0]!.n} @ ${rows[0]!.at?.toISOString() ?? '-'}`;
  }
  const { rows } = await testDb.client.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'master_version'`,
  );
  result.master_version = rows[0]!.value;
  return result;
}

async function auditRows(): Promise<{ actor: string; details: { tables: unknown } }[]> {
  const { rows } = await testDb.client.query<{ actor: string; details: { tables: unknown } }>(
    `SELECT actor, details FROM audit_log ORDER BY id`,
  );
  return rows;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: true });
  // The CLI runs as m100_app, like the API (doc 03 §7.5).
  db = new Database(testDb.pool('m100_app'));
  repos = pgImportRepositories(db);
  parsed = parseMaster(await fixtureTables());
});

afterAll(async () => {
  await testDb?.drop();
});

describe('importMaster (doc 02 §5.1)', () => {
  it('a dry run writes nothing and reports what a real run would write', async () => {
    const before = await snapshot();
    const result = await importMaster(db, repos, parsed, { dryRun: true });
    expect(result).toMatchObject({ dryRun: true, changed: true, masterVersion: 0 });
    expect(result.tables.psi_users).toEqual({ inserted: 5, updated: 0, unchanged: 0 });
    expect(result.tables.pos.inserted).toBe(FIXTURE_PO_EXPECTED.imported.length);
    expect(await snapshot()).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });

  it('rolls everything back when a write fails part way', async () => {
    const before = await snapshot();
    const failing: ImportRepositories = {
      ...repos,
      pos: { ...repos.pos, upsertMany: () => Promise.reject(new Error('disk full')) },
    };
    await expect(importMaster(db, failing, parsed, { dryRun: false })).rejects.toThrow('disk full');
    expect(await snapshot()).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });

  it('imports in one transaction, bumps master_version and writes one audit row', async () => {
    const result = await importMaster(db, repos, parsed, { dryRun: false });
    expect(result).toMatchObject({ dryRun: false, changed: true, masterVersion: 1 });
    expect(result.tables).toMatchObject({
      psi_users: { inserted: 5 },
      factories: { inserted: 2 },
      cells: { inserted: 3 },
      defects: { inserted: 98 },
      areas: { inserted: 12 },
      area_map: { inserted: 437 },
      pos: { inserted: 5 },
    });
    const { rows: pos } = await testDb.client.query<{ po: string; model: string; source: string }>(
      `SELECT po, model, source FROM pos ORDER BY po`,
    );
    expect(pos.map((p) => p.po).sort()).toEqual([...FIXTURE_PO_EXPECTED.imported].sort());
    expect(pos.find((p) => p.po === 'CX-0902368685')?.model).toBe('DURAMO SL2 M');
    expect(new Set(pos.map((p) => p.source))).toEqual(new Set(['import:fixture.xlsx']));

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(IMPORT_ACTOR);
    expect(audit[0]!.details.tables).toEqual(JSON.parse(JSON.stringify(result.tables)));
    // The audit row carries counts and PO numbers, never a person's name.
    expect(JSON.stringify(audit[0]!.details)).not.toMatch(/TEST (ANDI|BUDI|CITRA|DEWI)/);
  });

  it('a second run changes nothing: every row unchanged, master_version kept', async () => {
    const before = await snapshot();
    const result = await importMaster(db, repos, parseMaster(await fixtureTables()), {
      dryRun: false,
    });
    expect(result.changed).toBe(false);
    expect(result.masterVersion).toBe(1);
    for (const counts of Object.values(result.tables)) {
      expect(counts.inserted + counts.updated).toBe(0);
    }
    expect(await snapshot()).toEqual(before);
    // The run itself is still recorded.
    expect(await auditRows()).toHaveLength(2);
  });

  it('keeps rows an admin deactivated, and rows missing from a later file (never deletes)', async () => {
    await testDb.client.query(`UPDATE defects SET active = false WHERE id = 'D010'`);
    const later = parseMaster(await fixtureTables());
    const result = await importMaster(
      db,
      repos,
      { ...later, pos: later.pos.slice(1) },
      { dryRun: false },
    );
    expect(result.changed).toBe(false);
    const { rows } = await testDb.client.query<{ active: boolean; n: number }>(
      `SELECT (SELECT active FROM defects WHERE id = 'D010') AS active, (SELECT count(*)::int FROM pos) AS n`,
    );
    expect(rows[0]).toEqual({ active: false, n: FIXTURE_PO_EXPECTED.imported.length });
  });

  it('bumps master_version when a value changed', async () => {
    const changed = parseMaster(await fixtureTables());
    changed.pos[0] = { ...changed.pos[0]!, orderQty: 18 };
    const result = await importMaster(db, repos, changed, { dryRun: false });
    expect(result.tables.pos).toEqual({ inserted: 0, updated: 1, unchanged: 4 });
    expect(result.masterVersion).toBe(2);
  });

  it('invalid input stops in parseMaster, before any connection is used', async () => {
    const before = await snapshot();
    const tables = await fixtureTables({ defects: (rows) => rows.slice(1) });
    expect(() => parseMaster(tables)).toThrow(ImportInvalid);
    expect(await snapshot()).toEqual(before);
  });
});
