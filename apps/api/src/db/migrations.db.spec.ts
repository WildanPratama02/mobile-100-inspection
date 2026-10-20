import { createTestDatabase, migrateAsOwner, type TestDatabase } from '../testing/database';
import { listMigrations, migrate } from './migrate';

/** Everything a migration can create, so a second run can be compared object by object. */
const CATALOG = `
  SELECT 'relation' AS kind, c.relname || ':' || c.relkind || ':' || pg_get_userbyid(c.relowner)
         || ':' || coalesce(array_to_string(c.relacl, ','), '') AS item
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'column', c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraint', conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace
  UNION ALL
  SELECT 'trigger', tgrelid::regclass || ':' || tgname FROM pg_trigger WHERE NOT tgisinternal
  UNION ALL
  SELECT 'view', viewname || ':' || definition FROM pg_views WHERE schemaname = 'public'
  UNION ALL
  SELECT 'setting', key || '=' || value FROM settings
  ORDER BY 1, 2`;

describe('db/migrations on an empty database (T2.2)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('applies every migration as m100_migrate and records it', async () => {
    const files = listMigrations();

    const first = await migrateAsOwner(db);

    expect(first.applied).toEqual(files.map((m) => m.version));
    const { rows } = await db.client.query<{ version: string; sha256: string }>(
      'SELECT version, sha256 FROM schema_migrations ORDER BY version',
    );
    expect(rows).toEqual(files.map((m) => ({ version: m.version, sha256: m.sha256 })));
  });

  it('changes nothing when run again', async () => {
    const before = await db.client.query(CATALOG);

    const second = await migrateAsOwner(db);

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toHaveLength(listMigrations().length);
    const after = await db.client.query(CATALOG);
    expect(after.rows).toEqual(before.rows);
    expect(before.rows.length).toBeGreaterThan(100);
  });

  it('creates every table and view of doc 02, owned by m100_migrate', async () => {
    const { rows } = await db.client.query<{ relname: string; relkind: string; owner: string }>(
      `SELECT relname, relkind, pg_get_userbyid(relowner) AS owner FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'v') ORDER BY relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual([
      'admins',
      'area_map',
      'areas',
      'audit_log',
      'cells',
      'defects',
      'devices',
      'factories',
      'families',
      'pos',
      'psi_users',
      'schema_migrations',
      'settings',
      'sub_areas',
      'submission_findings',
      'submission_photos',
      'submissions',
      'v_defect_totals',
      'v_findings',
      'v_submissions',
      'v_top5',
    ]);
    expect(new Set(rows.map((r) => r.owner))).toEqual(new Set(['m100_migrate']));
  });

  it('installs pg_trgm and the trigram index for the PO search (doc 02 §3.3)', async () => {
    const ext = await db.client.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
    expect(ext.rowCount).toBe(1);
    const { rows } = await db.client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'pos_search_trgm_idx'`,
    );
    expect(rows[0]?.indexdef).toMatch(/USING gin .*gin_trgm_ops/);
  });

  it('writes the settings rows', async () => {
    const { rows } = await db.client.query('SELECT key, value FROM settings ORDER BY key');
    expect(rows).toEqual([
      { key: 'master_version', value: '0' },
      { key: 'submit_enabled', value: 'true' },
    ]);
  });

  it('stops, naming the version, when an applied file was changed', async () => {
    const changed = listMigrations().map((m) =>
      m.version === '0002_operations' ? { ...m, sha256: '0'.repeat(64) } : m,
    );
    await db.client.query('SET ROLE m100_migrate');
    try {
      await expect(migrate(db.client, changed)).rejects.toThrow('0002_operations was changed');
    } finally {
      await db.client.query('RESET ROLE');
    }
  });

  it('rolls a failing migration back completely', async () => {
    const broken = [
      ...listMigrations(),
      { version: '9999_broken', sql: 'CREATE TABLE half_done (id int); SELECT 1/0;', sha256: 'x' },
    ];
    await db.client.query('SET ROLE m100_migrate');
    try {
      await expect(migrate(db.client, broken)).rejects.toThrow('Migration 9999_broken failed');
    } finally {
      await db.client.query('RESET ROLE');
    }
    const table = await db.client.query<{ t: string | null }>(
      `SELECT to_regclass('half_done') AS t`,
    );
    expect(table.rows[0]?.t).toBeNull();
    const recorded = await db.client.query(
      `SELECT 1 FROM schema_migrations WHERE version = '9999_broken'`,
    );
    expect(recorded.rowCount).toBe(0);
  });
});
