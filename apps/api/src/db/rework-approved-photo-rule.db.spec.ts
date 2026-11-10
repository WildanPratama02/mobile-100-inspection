import { createTestDatabase, type TestDatabase } from '../testing/database';
import { insertSubmission, seedMasterData, submissionRow } from '../testing/schema-fixtures';
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
      migrations.filter((m) => m.version < '0007'),
    );
  } finally {
    await db.client.query('RESET ROLE');
  }
  await db.as('m100_migrate', seedMasterData, { commit: true });
  oldId = await insertSubmission(db.client, submissionRow());
  original = (
    await db.client.query<Record<string, unknown>>('SELECT * FROM submissions WHERE id = $1', [
      oldId,
    ])
  ).rows[0]!;
});

afterAll(async () => {
  await db?.drop();
});

const storedOf = async (id: string) =>
  (
    await db.client.query<Record<string, unknown>>(
      'SELECT qty_rework_approved, photo_rule FROM v_submissions WHERE id = $1',
      [id],
    )
  ).rows[0];

it('applies 0007 once, leaves existing rows untouched with both columns NULL, and a second run applies nothing', async () => {
  // migrate owns its transactions, so run it directly under the owner's role.
  await db.client.query('SET ROLE m100_migrate');
  try {
    expect((await migrate(db.client)).applied).toEqual(['0007_rework_approved_photo_rule']);
    const row = (
      await db.client.query<Record<string, unknown>>('SELECT * FROM submissions WHERE id = $1', [
        oldId,
      ])
    ).rows[0];
    // No backfill (ADR-022 decision 4, amended): the old PSI lv.2 row keeps NULL, read as the Top 5 rule.
    expect(row).toEqual({ ...original, qty_rework_approved: null, photo_rule: null });
    expect((await migrate(db.client)).applied).toEqual([]);
  } finally {
    await db.client.query('RESET ROLE');
  }
  expect(await storedOf(oldId)).toEqual({ qty_rework_approved: null, photo_rule: null });
});

it.each([
  ['qty_rework_approved', 0],
  ['photo_rule', "'TOP5'"],
])(
  'refuses an UPDATE of %s like every submission column, also by the owner',
  async (column, value) => {
    await expect(
      db.client.query(`UPDATE submissions SET ${column} = ${value} WHERE id = $1`, [oldId]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      db.as('m100_migrate', (c) =>
        c.query(`UPDATE submissions SET ${column} = ${value} WHERE id = $1`, [oldId]),
      ),
    ).rejects.toMatchObject({ code: '23001' });
    // The API role has no UPDATE grant at all.
    await expect(
      db.as('m100_app', (c) =>
        c.query(`UPDATE submissions SET ${column} = ${value} WHERE id = $1`, [oldId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await storedOf(oldId)).toEqual({ qty_rework_approved: null, photo_rule: null });
  },
);

it.each([
  ['Rework and Approved above qty_rework', { qty_rework_approved: 11 }],
  ['negative Rework and Approved', { qty_rework_approved: -1 }],
  ['a photo rule on a PSI lv.1 row', { level: 'PSI lv.1', photo_count: 0, photo_rule: 'ALL' }],
  ['an unknown photo rule', { photo_rule: 'TOP10' }],
  ['a lower-case photo rule', { photo_rule: 'all' }],
])('refuses a row with %s (CHECK)', async (_label, overrides) => {
  await expect(insertSubmission(db.client, submissionRow(overrides))).rejects.toMatchObject({
    code: '23514',
  });
});

it.each([
  [
    'Rework and Approved equal to qty_rework and ALL',
    { qty_rework_approved: 10, photo_rule: 'ALL' },
  ],
  ['Rework and Approved 0 and TOP5', { qty_rework_approved: 0, photo_rule: 'TOP5' }],
  [
    'PSI lv.1 with Rework and Approved and no photo rule',
    { level: 'PSI lv.1', qty_rework_approved: 3 },
  ],
])('accepts %s and exposes both through v_submissions', async (_label, overrides) => {
  const id = await insertSubmission(db.client, submissionRow(overrides));
  expect(await storedOf(id)).toEqual({
    qty_rework_approved: overrides.qty_rework_approved,
    photo_rule: 'photo_rule' in overrides ? overrides.photo_rule : null,
  });
});

it('keeps the reporting role on v_submissions with the new columns', async () => {
  const rows = await db.as(
    'm100_report',
    async (c) =>
      (
        await c.query<Record<string, unknown>>(
          'SELECT qty_rework_approved, photo_rule FROM v_submissions WHERE id = $1',
          [oldId],
        )
      ).rows,
  );
  expect(rows).toEqual([{ qty_rework_approved: null, photo_rule: null }]);
});
