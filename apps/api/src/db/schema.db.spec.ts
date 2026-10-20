import { createTestDatabase, sqlState, type TestDatabase } from '../testing/database';
import {
  FINDINGS,
  insertFinding,
  insertPhoto,
  insertSubmission,
  seedMasterData,
  submissionRow,
} from '../testing/schema-fixtures';

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const RESTRICT_VIOLATION = '23001';

let db: TestDatabase;
let stored: string;

beforeAll(async () => {
  db = await createTestDatabase({ migrated: true });
  await db.as('m100_migrate', seedMasterData, { commit: true });
  stored = await db.as(
    'm100_migrate',
    async (c) => {
      const id = await insertSubmission(c, submissionRow());
      for (const f of FINDINGS) await insertFinding(c, id, f);
      await insertPhoto(c, id, 'D001');
      return id;
    },
    { commit: true },
  );
});
afterAll(async () => {
  await db?.drop();
});

describe('submissions check constraints (doc 02 §4.1)', () => {
  it('accept a submission whose totals agree with its counts, and number it', async () => {
    const { rows } = await db.client.query<{ display_no: string }>(
      'SELECT display_no FROM submissions WHERE id = $1',
      [stored],
    );
    expect(Number(rows[0]?.display_no)).toBeGreaterThanOrEqual(1);
  });

  it.each([
    [
      'Qty Inspection is not the sum of the counts',
      { qty_inspection: 31 },
      'submissions_qty_inspection_sum_check',
    ],
    ['A-Grade is not NO DEFECT', { qty_a_grade: 17 }, 'submissions_qty_a_grade_check'],
    ['B-Grade exceeds Qty Defect', { qty_b_grade: 12 }, 'submissions_qty_b_grade_le_defect_check'],
    [
      'Qty Inspection is 0',
      {
        qty_rework: 0,
        qty_bgrade_inspections: 0,
        qty_no_defect: 0,
        qty_inspection: 0,
        qty_a_grade: 0,
      },
      'submissions_qty_inspection_check',
    ],
    ['only partial_no is set', { partial_qty: null }, 'submissions_partial_check'],
    ['only partial_qty is set', { partial_no: null }, 'submissions_partial_check'],
    ['partial_qty exceeds order_qty', { partial_qty: 10003 }, 'submissions_partial_check'],
    ['partial_no is 0', { partial_no: 0 }, 'submissions_partial_no_check'],
    [
      'a count is negative',
      { qty_rework: -1, qty_no_defect: 29, qty_a_grade: 29 },
      'submissions_qty_rework_check',
    ],
    [
      'the payload hash is not 32 bytes',
      { payload_sha256: Buffer.alloc(16) },
      'submissions_payload_sha256_check',
    ],
    ['the level is unknown', { level: 'CFA' }, 'submissions_level_check'],
  ])('reject a submission when %s', async (_why, overrides, constraint) => {
    const error = await db
      .as('m100_migrate', (c) => insertSubmission(c, submissionRow(overrides)))
      .catch((e: { code?: string; constraint?: string }) => e);
    expect(error).toMatchObject({ code: CHECK_VIOLATION, constraint });
  });

  it('accept a submission that is not partial', async () => {
    await expect(
      db.as('m100_migrate', (c) =>
        insertSubmission(c, submissionRow({ partial_no: null, partial_qty: null })),
      ),
    ).resolves.toBeDefined();
  });

  it('reject a second submission with the same UUID', async () => {
    expect(
      await sqlState(
        db.as('m100_migrate', (c) => insertSubmission(c, submissionRow({ id: stored }))),
      ),
    ).toBe(UNIQUE_VIOLATION);
  });
});

describe('findings and photos (doc 02 §4.2, §4.3)', () => {
  it('reject a second finding for the same type, area, sub-area and defect', async () => {
    expect(
      await sqlState(db.as('m100_migrate', (c) => insertFinding(c, stored, FINDINGS[0]!))),
    ).toBe(UNIQUE_VIOLATION);
  });

  it('reject a finding with quantity 0 or an unknown defect', async () => {
    const f = { ...FINDINGS[0]!, inspectionType: 'B-GRADE' as const };
    expect(
      await sqlState(db.as('m100_migrate', (c) => insertFinding(c, stored, { ...f, qty: 0 }))),
    ).toBe(CHECK_VIOLATION);
    const unknown = db.as('m100_migrate', (c) =>
      c.query(
        `INSERT INTO submission_findings (submission_id, inspection_type, area_id, sub_area_id, family_id, defect_id,
           defect_name, severity, qty, first_recorded_at)
         VALUES ($1, 'REWORK', 'A01', 'SA01', 'F01', 'D099', 'X', 'MINOR', 1, now())`,
        [stored],
      ),
    );
    expect(await sqlState(unknown)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('reject a second photo for the same defect (AC-10.5)', async () => {
    expect(await sqlState(db.as('m100_migrate', (c) => insertPhoto(c, stored, 'D001')))).toBe(
      UNIQUE_VIOLATION,
    );
  });

  it('reject a photo over 1 MB', async () => {
    const big = db.as('m100_migrate', (c) =>
      c.query(
        `INSERT INTO submission_photos (submission_id, defect_id, object_key, sha256, size_bytes)
         VALUES ($1, 'D002', 'submissions/2026/10/x/D002.jpg', $2, 1048577)`,
        [stored, Buffer.alloc(32)],
      ),
    );
    expect(await sqlState(big)).toBe(CHECK_VIOLATION);
  });
});

describe('immutability trigger (BR-07, doc 02 §4.1)', () => {
  const statements: [string, string][] = [
    ['UPDATE submissions', `UPDATE submissions SET username = 'X' WHERE id = $1`],
    ['DELETE FROM submissions', `DELETE FROM submissions WHERE id = $1`],
    [
      'UPDATE submission_findings',
      `UPDATE submission_findings SET qty = qty + 1 WHERE submission_id = $1`,
    ],
    ['DELETE FROM submission_findings', `DELETE FROM submission_findings WHERE submission_id = $1`],
    [
      'UPDATE submission_photos',
      `UPDATE submission_photos SET size_bytes = 1 WHERE submission_id = $1`,
    ],
    ['DELETE FROM submission_photos', `DELETE FROM submission_photos WHERE submission_id = $1`],
  ];

  it.each(statements)('%s fails for the owner m100_migrate', async (_name, sql) => {
    const error: unknown = await db
      .as('m100_migrate', (c) => c.query(sql, [stored]))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toMatchObject({ code: RESTRICT_VIOLATION });
    expect((error as Error).message).toContain('immutable');
  });

  it.each(statements)('%s fails even for a superuser', async (_name, sql) => {
    await db.client.query('BEGIN');
    try {
      expect(await sqlState(db.client.query(sql, [stored]))).toBe(RESTRICT_VIOLATION);
    } finally {
      await db.client.query('ROLLBACK');
    }
  });

  it.each(['submissions', 'submission_findings', 'submission_photos'])(
    'TRUNCATE %s fails',
    async (table) => {
      await db.client.query('BEGIN');
      try {
        expect(await sqlState(db.client.query(`TRUNCATE ${table} CASCADE`))).toBe(
          RESTRICT_VIOLATION,
        );
      } finally {
        await db.client.query('ROLLBACK');
      }
    },
  );

  it('leaves the stored rows unchanged', async () => {
    const { rows } = await db.client.query(
      `SELECT (SELECT count(*) FROM submission_findings WHERE submission_id = $1)::int AS findings,
              (SELECT count(*) FROM submission_photos WHERE submission_id = $1)::int AS photos,
              (SELECT username FROM submissions WHERE id = $1) AS username`,
      [stored],
    );
    expect(rows[0]).toEqual({
      findings: FINDINGS.length,
      photos: 1,
      username: 'ROIS FATHUR ROHIM',
    });
  });
});

describe('master data constraints (doc 02 §3)', () => {
  it('reject an area_map row whose sub-area belongs to another area (§3.5)', async () => {
    // A new family, so the unique key (sub-area, family, defect) cannot fire before the foreign key.
    const wrong = db.as('m100_migrate', async (c) => {
      await c.query(`INSERT INTO families (id, name) VALUES ('F02', 'STITCHING')`);
      return c.query(
        `INSERT INTO area_map (id, area_id, sub_area_id, family_id, defect_id) VALUES ('MAP-X', 'A01', 'SA02', 'F02', 'D001')`,
      );
    });
    expect(await sqlState(wrong)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('reject a duplicate map row for the same sub-area, family and defect', async () => {
    const dup = db.as('m100_migrate', (c) =>
      c.query(
        `INSERT INTO area_map (id, area_id, sub_area_id, family_id, defect_id) VALUES ('MAP-Y', 'A01', 'SA01', 'F01', 'D001')`,
      ),
    );
    expect(await sqlState(dup)).toBe(UNIQUE_VIOLATION);
  });

  it.each([
    ['an area id outside A01–A12', `INSERT INTO areas (id, name, sort) VALUES ('A13', 'X', 13)`],
    [
      'a defect id that is not Dnnn',
      `INSERT INTO defects (id, name, severity) VALUES ('D1', 'X', 'MINOR')`,
    ],
    ['an unknown severity', `INSERT INTO defects (id, name, severity) VALUES ('D050', 'X', 'LOW')`],
    ['an unknown PSI level', `INSERT INTO psi_users (username, level) VALUES ('X', 'CFA')`],
    [
      'a PO with order quantity 0',
      `INSERT INTO pos (po, article, model, destination, order_qty, source) VALUES ('X', '', '', '', 0, 'admin')`,
    ],
  ])('reject %s', async (_why, sql) => {
    expect(await sqlState(db.as('m100_migrate', (c) => c.query(sql)))).toBe(CHECK_VIOLATION);
  });

  it('keep two defects with the same name apart (ADR-009: D049, D071)', async () => {
    await expect(
      db.as('m100_migrate', (c) =>
        c.query(`INSERT INTO defects (id, name, severity) VALUES
          ('D049', 'POOR TOUCH UP/PAINTING, MARKING LINE', 'MINOR'),
          ('D071', 'POOR TOUCH UP/PAINTING, MARKING LINE', 'MINOR')`),
      ),
    ).resolves.toBeDefined();
  });

  it('allow the same name at both PSI levels, once per level (§3.1)', async () => {
    await db.as('m100_migrate', async (c) => {
      await c.query(
        `INSERT INTO psi_users (username, level) VALUES ('EVA JULIYANI', 'PSI lv.1'), ('EVA JULIYANI', 'PSI lv.2')`,
      );
      expect(
        await sqlState(
          c.query(`INSERT INTO psi_users (username, level) VALUES ('EVA JULIYANI', 'PSI lv.1')`),
        ),
      ).toBe(UNIQUE_VIOLATION);
    });
  });

  it('keep the PO text exactly as imported and find it through the trigram index expression', async () => {
    const { rows } = await db.client.query(
      `SELECT po, model FROM pos
        WHERE lower(replace(po || ' ' || article || ' ' || model, U&'\\00A0', ' ')) LIKE '%runner x%'`,
    );
    expect(rows).toEqual([{ po: '0902028839', model: 'RUNNER X' }]);
  });
});
