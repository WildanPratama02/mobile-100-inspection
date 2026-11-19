import { createTestDatabase, sqlState, type TestDatabase } from '../testing/database';
import {
  FINDINGS,
  insertAdmin,
  insertFinding,
  insertPhoto,
  insertRevision,
  insertRevisionFinding,
  insertRevisionPhoto,
  insertSubmission,
  revisionRow,
  seedMasterData,
  submissionRow,
  type SubmissionRow,
} from '../testing/schema-fixtures';
import { listMigrations, migrate } from './migrate';

const RESTRICT = '23001';
const CHECK = '23514';
const UNIQUE = '23505';
const INSUFFICIENT_PRIVILEGE = '42501';

let db: TestDatabase;
let sub: SubmissionRow;
let adminId: number;
let original: Record<string, unknown>;
let viewBefore: Record<string, unknown>;

const asOwner = async <T>(fn: () => Promise<T>): Promise<T> => {
  await db.client.query('SET ROLE m100_migrate');
  try {
    return await fn();
  } finally {
    await db.client.query('RESET ROLE');
  }
};

const one = async (sql: string, params: unknown[] = []) =>
  (await db.client.query<Record<string, unknown>>(sql, params)).rows[0]!;

beforeAll(async () => {
  db = await createTestDatabase();
  await asOwner(() =>
    migrate(
      db.client,
      listMigrations().filter((m) => m.version < '0008'),
    ),
  );
  await db.as('m100_migrate', seedMasterData, { commit: true });
  sub = submissionRow();
  await db.as(
    'm100_migrate',
    async (c) => {
      await insertSubmission(c, sub);
      for (const f of FINDINGS) await insertFinding(c, String(sub.id), f);
      await insertPhoto(c, String(sub.id), 'D001');
      adminId = await insertAdmin(c);
    },
    { commit: true },
  );
  original = await one('SELECT * FROM submissions WHERE id = $1', [sub.id]);
  viewBefore = await one('SELECT * FROM v_submissions WHERE id = $1', [sub.id]);
});

afterAll(async () => {
  await db?.drop();
});

it('applies 0008 once; existing rows and their view values stay; a second run applies nothing', async () => {
  await asOwner(async () => {
    expect((await migrate(db.client)).applied).toEqual(['0008_submission_revisions']);
    expect((await migrate(db.client)).applied).toEqual([]);
  });
  expect(await one('SELECT * FROM submissions WHERE id = $1', [sub.id])).toEqual(original);
  expect(await one('SELECT * FROM v_submissions WHERE id = $1', [sub.id])).toEqual({
    ...viewBefore,
    revision_no: 0,
    corrected_at: null,
    corrected_by: null,
    correction_reason: null,
  });
  const { rows } = await db.client.query(
    'SELECT defect_id, rank_in_submission, has_photo FROM v_defect_totals WHERE submission_id = $1 ORDER BY 2',
    [sub.id],
  );
  expect(rows[0]).toEqual({ defect_id: 'D001', rank_in_submission: 1, has_photo: true });
});

describe('a revision (ADR-023, doc 02 §4.4)', () => {
  let revisionId: string;

  beforeAll(async () => {
    // NO DEFECT 18 → 19 (Qty Inspection 31), only the two D001 findings kept, D001's photo replaced.
    revisionId = await db.as(
      'm100_migrate',
      async (c) => {
        const id = await insertRevision(
          c,
          revisionRow(sub, adminId, {
            qty_no_defect: 19,
            qty_inspection: 31,
            qty_a_grade: 19,
            qty_b_grade: 1,
            qty_defect: 3,
            rft: '0.61290',
            defect_rate: '0.09677',
            photo_count: 1,
            cell: 'F3-11',
            qty_rework_approved: 2,
          }),
        );
        await insertRevisionFinding(c, id, FINDINGS[0]!);
        await insertRevisionFinding(c, id, FINDINGS[6]!);
        await insertRevisionPhoto(
          c,
          id,
          'D001',
          `submissions/2026/10/${String(sub.id)}/r1/D001.jpg`,
        );
        return id;
      },
      { commit: true },
    );
  });

  it('is what the reporting views show; the original rows stay unchanged', async () => {
    expect(
      await one(
        `SELECT cell, qty_no_defect, qty_inspection, qty_a_grade, qty_defect, qty_rework_approved, rft::text,
                revision_no, corrected_by, correction_reason, display_no = $2 AS same_no
           FROM v_submissions WHERE id = $1`,
        [sub.id, viewBefore.display_no],
      ),
    ).toEqual({
      cell: 'F3-11',
      qty_no_defect: 19,
      qty_inspection: 31,
      qty_a_grade: 19,
      qty_defect: 3,
      qty_rework_approved: 2,
      rft: '0.61290',
      revision_no: 1,
      corrected_by: 'qip.digital',
      correction_reason: 'Salah input oleh PSI, dikoreksi admin',
      same_no: true,
    });
    expect(await one('SELECT * FROM submissions WHERE id = $1', [sub.id])).toEqual(original);

    const findings = await db.client.query(
      'SELECT defect_id, inspection_type, cell FROM v_findings WHERE submission_id = $1 ORDER BY first_recorded_at',
      [sub.id],
    );
    expect(findings.rows).toEqual([
      { defect_id: 'D001', inspection_type: 'REWORK', cell: 'F3-11' },
      { defect_id: 'D001', inspection_type: 'B-GRADE', cell: 'F3-11' },
    ]);
    const top = await db.client.query(
      'SELECT defect_id, qty, has_photo FROM v_top5 WHERE submission_id = $1',
      [sub.id],
    );
    expect(top.rows).toEqual([{ defect_id: 'D001', qty: 3, has_photo: true }]);

    const photo = await one(
      'SELECT source, object_key FROM v_effective_photos WHERE submission_id = $1',
      [sub.id],
    );
    expect(photo).toEqual({
      source: 'revision',
      object_key: `submissions/2026/10/${String(sub.id)}/r1/D001.jpg`,
    });
  });

  it('a later revision wins', async () => {
    await db.as('m100_migrate', async (c) => {
      await insertRevision(
        c,
        revisionRow(sub, adminId, { revision_no: 2, cell: 'F3-12', qty_rework_approved: 1 }),
      );
      expect(
        (await c.query('SELECT cell, revision_no FROM v_submissions WHERE id = $1', [sub.id]))
          .rows[0],
      ).toEqual({ cell: 'F3-12', revision_no: 2 });
      // Revision 2 has no findings or photos of its own.
      expect(
        (
          await c.query('SELECT count(*)::int AS n FROM v_findings WHERE submission_id = $1', [
            sub.id,
          ])
        ).rows[0],
      ).toEqual({ n: 0 });
    });
  });

  it.each([
    ['submission_revisions', `UPDATE submission_revisions SET reason = 'x' WHERE id = $1`],
    ['submission_revisions', `DELETE FROM submission_revisions WHERE id = $1`],
    [
      'submission_revision_findings',
      `UPDATE submission_revision_findings SET qty = 9 WHERE revision_id = $1`,
    ],
    [
      'submission_revision_findings',
      `DELETE FROM submission_revision_findings WHERE revision_id = $1`,
    ],
    [
      'submission_revision_photos',
      `UPDATE submission_revision_photos SET size_bytes = 1 WHERE revision_id = $1`,
    ],
    ['submission_revision_photos', `DELETE FROM submission_revision_photos WHERE revision_id = $1`],
  ])('%s: %s is refused, also for the owner', async (_table, sql) => {
    expect(await sqlState(db.as('m100_migrate', (c) => c.query(sql, [revisionId])))).toBe(RESTRICT);
    expect(await sqlState(db.as('m100_app', (c) => c.query(sql, [revisionId])))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it.each(['submission_revisions', 'submission_revision_findings', 'submission_revision_photos'])(
    'TRUNCATE %s is refused',
    async (table) => {
      expect(
        await sqlState(db.as('m100_migrate', (c) => c.query(`TRUNCATE ${table} CASCADE`))),
      ).toBe(RESTRICT);
    },
  );
});

describe('checks of a revision row', () => {
  const tryInsert = (overrides: SubmissionRow) =>
    sqlState(
      db.as('m100_app', (c) =>
        insertRevision(c, revisionRow(sub, adminId, { revision_no: 9, ...overrides })),
      ),
    );

  it('refuses totals that break the original counting rule (ADR-008 here)', async () => {
    expect(await tryInsert({ qty_inspection: 29 })).toBe(CHECK);
    expect(await tryInsert({ qty_a_grade: 17 })).toBe(CHECK);
    expect(await tryInsert({ qty_no_defect: null })).toBe(CHECK);
  });

  it('refuses a short reason, approval above rework, a bad partial and a repeated number', async () => {
    expect(await tryInsert({ reason: '  kurang  ' })).toBe(CHECK);
    expect(await tryInsert({ qty_rework_approved: 11 })).toBe(CHECK);
    expect(await tryInsert({ partial_qty: 20000 })).toBe(CHECK);
    expect(await tryInsert({ revision_no: 1 })).toBe(UNIQUE);
  });

  it('accepts a valid row from the API role', async () => {
    await db.as('m100_app', async (c) => {
      await insertRevision(c, revisionRow(sub, adminId, { revision_no: 9 }));
      await c.query('SELECT * FROM v_effective_submissions');
      await c.query('SELECT * FROM v_effective_findings');
      await c.query('SELECT * FROM v_effective_photos');
    });
  });

  it('applies the ADR-019 checks to an entered-count original', async () => {
    const entered = submissionRow({
      counting_rule: 'ADR-019',
      level: 'PSI lv.1',
      qty_no_defect: null,
      qty_a_grade: 19,
      rft: '0.63333',
      partial_no: null,
      partial_qty: null,
      photo_count: 0,
    });
    await db.as(
      'm100_migrate',
      async (c) => {
        await insertSubmission(c, entered);
      },
      { commit: true },
    );
    const bad = (o: SubmissionRow) =>
      sqlState(db.as('m100_app', (c) => insertRevision(c, revisionRow(entered, adminId, o))));
    expect(await bad({ qty_inspection: 10 })).toBe(CHECK); // below Qty Defect 11
    expect(await bad({ qty_inspection: 10003, qty_a_grade: 9992 })).toBe(CHECK); // above Qty Order
    expect(await bad({ qty_no_defect: 18 })).toBe(CHECK);
    await db.as('m100_app', (c) =>
      insertRevision(
        c,
        revisionRow(entered, adminId, { qty_inspection: 25, qty_a_grade: 14, rft: '0.56000' }),
      ),
    );
  });
});
