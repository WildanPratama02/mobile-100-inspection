import { createTestDatabase, type TestDatabase } from '../testing/database';
import {
  FINDINGS,
  insertFinding,
  insertSubmission,
  seedMasterData,
  submissionRow,
} from '../testing/schema-fixtures';
import { listMigrations, migrate } from './migrate';

let db: TestDatabase;
let oldId: string;
let original: Record<string, unknown>;
const migrations = listMigrations();

beforeAll(async () => {
  db = await createTestDatabase();
  await db.client.query('SET ROLE m100_migrate');
  try {
    await migrate(
      db.client,
      migrations.filter((m) => m.version < '0006'),
    );
  } finally {
    await db.client.query('RESET ROLE');
  }
  await db.as('m100_migrate', seedMasterData, { commit: true });
  const old = submissionRow();
  delete old.counting_rule;
  oldId = await insertSubmission(db.client, old);
  original = (
    await db.client.query<Record<string, unknown>>('SELECT * FROM submissions WHERE id = $1', [
      oldId,
    ])
  ).rows[0]!;
});

afterAll(async () => {
  await db?.drop();
});

it('migrates immutable ADR-008 rows without recalculation and is idempotent', async () => {
  // migrate owns its transactions, so run it directly under the owner's role.
  await db.client.query('SET ROLE m100_migrate');
  try {
    expect((await migrate(db.client)).applied).toEqual(['0006_manual_qty_inspection']);
    const row = (
      await db.client.query<Record<string, unknown>>('SELECT * FROM submissions WHERE id = $1', [
        oldId,
      ])
    ).rows[0];
    expect(row).toEqual({ ...original, counting_rule: 'ADR-008' });
    expect((await migrate(db.client)).applied).toEqual([]);
  } finally {
    await db.client.query('RESET ROLE');
  }
  await expect(
    db.client.query('UPDATE submissions SET qty_a_grade = 18 WHERE id = $1', [oldId]),
  ).rejects.toMatchObject({ code: '23001' });
  await expect(
    db.client.query('DELETE FROM submissions WHERE id = $1', [oldId]),
  ).rejects.toMatchObject({ code: '23001' });
});

it('requires an explicit counting rule on new rows', async () => {
  const row = submissionRow();
  delete row.counting_rule;
  await expect(insertSubmission(db.client, row)).rejects.toMatchObject({ code: '23502' });
});

it.each([
  ['NO DEFECT present', { qty_no_defect: 18 }],
  ['A-Grade disagrees', { qty_a_grade: 18 }],
  ['inspection below findings', { qty_inspection: 10, qty_a_grade: -1 }],
  ['inspection above partial', { partial_qty: 29 }],
  ['inspection above order', { partial_no: null, partial_qty: null, order_qty: 29 }],
  ['unknown rule', { counting_rule: 'ADR-999' }],
])('refuses ADR-019 rows with %s', async (_label, overrides) => {
  await expect(
    insertSubmission(
      db.client,
      submissionRow({
        counting_rule: 'ADR-019',
        qty_no_defect: null,
        qty_a_grade: 19,
        ...overrides,
      }),
    ),
  ).rejects.toMatchObject({ code: '23514' });
});

it('accepts both rules and exposes the stored rule through every reporting view', async () => {
  const id = await insertSubmission(
    db.client,
    submissionRow({
      counting_rule: 'ADR-019',
      qty_no_defect: null,
      qty_a_grade: 19,
    }),
  );
  const old = await insertSubmission(db.client, submissionRow());
  for (const finding of FINDINGS) await insertFinding(db.client, id, finding);
  expect(
    (
      await db.client.query(
        'SELECT counting_rule, qty_no_defect FROM v_submissions WHERE id = $1',
        [id],
      )
    ).rows,
  ).toEqual([{ counting_rule: 'ADR-019', qty_no_defect: null }]);
  expect(
    (await db.client.query('SELECT counting_rule FROM v_submissions WHERE id = $1', [old])).rows,
  ).toEqual([{ counting_rule: 'ADR-008' }]);
  for (const view of ['v_findings', 'v_defect_totals', 'v_top5']) {
    const rows = (
      await db.client.query(`SELECT DISTINCT counting_rule FROM ${view} WHERE submission_id = $1`, [
        id,
      ])
    ).rows;
    expect(rows).toEqual([{ counting_rule: 'ADR-019' }]);
  }
});
