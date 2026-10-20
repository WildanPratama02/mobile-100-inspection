import { createTestDatabase, sqlState, type TestDatabase } from '../testing/database';
import {
  FINDINGS,
  insertFinding,
  insertPhoto,
  insertSubmission,
  seedMasterData,
  submissionRow,
} from '../testing/schema-fixtures';

const INSUFFICIENT_PRIVILEGE = '42501';

let db: TestDatabase;
let stored: string;

beforeAll(async () => {
  db = await createTestDatabase({ migrated: true });
  await db.as('m100_migrate', seedMasterData, { commit: true });
  stored = await db.as(
    'm100_migrate',
    async (c) => {
      const id = await insertSubmission(c, submissionRow());
      await insertFinding(c, id, FINDINGS[0]!);
      await insertPhoto(c, id, 'D001');
      return id;
    },
    { commit: true },
  );
});
afterAll(async () => {
  await db?.drop();
});

const VIEWS = ['v_submissions', 'v_findings', 'v_defect_totals', 'v_top5'];
const SUBMISSION_TABLES = ['submissions', 'submission_findings', 'submission_photos'];
const MASTER_TABLES = [
  'psi_users',
  'factories',
  'cells',
  'pos',
  'defects',
  'areas',
  'sub_areas',
  'families',
  'area_map',
];
const ALL_TABLES = [
  ...MASTER_TABLES,
  ...SUBMISSION_TABLES,
  'devices',
  'admins',
  'audit_log',
  'settings',
  'schema_migrations',
];

describe('m100_report reads the views and nothing else (doc 02 §8, doc 03 §6)', () => {
  it.each(VIEWS)('SELECT from %s works', async (view) => {
    const { rowCount } = await db.as('m100_report', (c) => c.query(`SELECT * FROM ${view}`));
    expect(rowCount).toBeGreaterThanOrEqual(1);
  });

  it.each(ALL_TABLES)('SELECT from table %s is refused', async (table) => {
    expect(
      await sqlState(db.as('m100_report', (c) => c.query(`SELECT 1 FROM ${table} LIMIT 1`))),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot write through a view or create anything', async () => {
    expect(
      await sqlState(
        db.as('m100_report', (c) => c.query(`DELETE FROM v_submissions WHERE id = $1`, [stored])),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(db.as('m100_report', (c) => c.query('CREATE TABLE mine (id int)')))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('has privileges on the four views only', async () => {
    const { rows } = await db.client.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'm100_report' ORDER BY table_name`,
    );
    expect(rows).toEqual(
      VIEWS.slice()
        .sort()
        .map((v) => ({ table_name: v, privilege_type: 'SELECT' })),
    );
  });
});

describe('m100_app (doc 03 §6)', () => {
  it.each(SUBMISSION_TABLES)(
    'cannot DELETE from %s (no grant, before the trigger)',
    async (table) => {
      const column = table === 'submissions' ? 'id' : 'submission_id';
      expect(
        await sqlState(
          db.as('m100_app', (c) => c.query(`DELETE FROM ${table} WHERE ${column} = $1`, [stored])),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    },
  );

  it.each([
    `UPDATE submissions SET username = 'X' WHERE id = $1`,
    `UPDATE submission_findings SET qty = 1 WHERE submission_id = $1`,
    `UPDATE submission_photos SET size_bytes = 1 WHERE submission_id = $1`,
  ])('cannot %s', async (sql) => {
    expect(await sqlState(db.as('m100_app', (c) => c.query(sql, [stored])))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it.each([...MASTER_TABLES, 'devices', 'admins', 'audit_log', 'settings'])(
    'cannot DELETE from %s (master data is deactivated, never deleted)',
    async (table) => {
      expect(await sqlState(db.as('m100_app', (c) => c.query(`DELETE FROM ${table}`)))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    },
  );

  it('writes a whole submission with findings and photos, numbered by the identity column', async () => {
    await db.as('m100_app', async (c) => {
      const id = await insertSubmission(c, submissionRow());
      for (const f of FINDINGS) await insertFinding(c, id, f);
      await insertPhoto(c, id, 'D002');
      const { rows } = await c.query<{ display_no: string }>(
        'SELECT display_no FROM submissions WHERE id = $1',
        [id],
      );
      expect(Number(rows[0]?.display_no)).toBeGreaterThan(1);
    });
  });

  it('deactivates master data, bumps master_version, logs to audit_log and reads the views', async () => {
    await db.as('m100_app', async (c) => {
      await c.query(`UPDATE defects SET active = false, updated_at = now() WHERE id = 'D007'`);
      await c.query(
        `UPDATE settings SET value = (value::int + 1)::text WHERE key = 'master_version'`,
      );
      await c.query(
        `INSERT INTO audit_log (actor, action, entity, entity_id, details) VALUES ('admin:qip', 'deactivate', 'defect', 'D007', '{}')`,
      );
      await c.query('SELECT * FROM v_top5');
      await c.query('SELECT version FROM schema_migrations');
    });
  });

  it('cannot change the audit log or create tables', async () => {
    expect(
      await sqlState(db.as('m100_app', (c) => c.query(`UPDATE audit_log SET actor = 'system'`))),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(db.as('m100_app', (c) => c.query('CREATE TABLE mine (id int)')))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });
});
