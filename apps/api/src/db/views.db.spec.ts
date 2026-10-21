import { inspectionDate, partialText, rankDefects } from '@m100/shared';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import {
  defectOf,
  FINDINGS,
  insertFinding,
  insertPhoto,
  insertSubmission,
  seedMasterData,
  submissionRow,
} from '../testing/schema-fixtures';

let db: TestDatabase;
let example: string;
let lv1: string;

const TOP5 = rankDefects(FINDINGS, (id) => defectOf(id).severity)
  .slice(0, 5)
  .map((d) => d.defectId);

beforeAll(async () => {
  db = await createTestDatabase({ migrated: true });
  await db.as('m100_migrate', seedMasterData, { commit: true });
  [example, lv1] = await db.as(
    'm100_migrate',
    async (c) => {
      const id = await insertSubmission(c, submissionRow());
      for (const f of FINDINGS) await insertFinding(c, id, f);
      for (const defectId of TOP5) await insertPhoto(c, id, defectId);
      // PSI lv.1, not partial, NO DEFECT only: no findings and no photos.
      const other = await insertSubmission(
        c,
        submissionRow({
          level: 'PSI lv.1',
          username: 'EVA JULIYANI',
          partial_no: null,
          partial_qty: null,
          qty_rework: 0,
          qty_bgrade_inspections: 0,
          qty_no_defect: 4,
          qty_inspection: 4,
          qty_a_grade: 4,
          qty_b_grade: 0,
          qty_defect: 0,
          rft: '1.00000',
          defect_rate: '0.00000',
          photo_count: 0,
        }),
      );
      return [id, other] as const;
    },
    { commit: true },
  );
});
afterAll(async () => {
  await db?.drop();
});

describe('v_submissions (doc 02 §8, §9)', () => {
  it('shows the doc 02 §9 example with its stored totals, partial text and WIB time', async () => {
    const { rows } = await db.as('m100_report', (c) =>
      // Dates and times as text: node-pg would turn them into Date objects in the machine's time zone.
      c.query(
        `SELECT *, sealed_at::text AS sealed_at, inspection_date::text AS inspection_date
           FROM v_submissions WHERE id = $1`,
        [example],
      ),
    );
    expect(rows[0]).toMatchObject({
      qty_inspection: 30,
      qty_a_grade: 18,
      qty_b_grade: 3,
      qty_defect: 11,
      rft: '0.60000',
      defect_rate: '0.36667',
      partial_text: 'P1 1.200 OF 10.002',
      sealed_at: '2026-10-17 00:30:00',
      inspection_date: '2026-10-17',
      photo_count: 5,
      counting_rule: 'ADR-008',
      model: 'RUNNER X',
    });
  });

  it('computes partial text and inspection date like packages/shared (doc 03 §5.5)', async () => {
    const row = submissionRow();
    const { rows } = await db.as('m100_report', (c) =>
      c.query<{ partial_text: string }>('SELECT partial_text FROM v_submissions WHERE id = $1', [
        example,
      ]),
    );
    expect(rows[0]?.partial_text).toBe(
      partialText(
        { number: Number(row.partial_no), qty: Number(row.partial_qty) },
        Number(row.order_qty),
      ),
    );
    expect(inspectionDate(String(row.sealed_at))).toBe(row.inspection_date);
  });

  it('shows WIB regardless of the session time zone', async () => {
    const { rows } = await db.as('m100_report', async (c) => {
      await c.query(`SET LOCAL TIME ZONE 'UTC'`);
      return c.query<{ sealed_at: string }>(
        'SELECT sealed_at::text AS sealed_at FROM v_submissions WHERE id = $1',
        [example],
      );
    });
    expect(rows[0]?.sealed_at).toBe('2026-10-17 00:30:00');
  });

  it('has no partial text for a PO that is not partial', async () => {
    const { rows } = await db.as('m100_report', (c) =>
      c.query<{ partial_text: string | null }>(
        'SELECT partial_text FROM v_submissions WHERE id = $1',
        [lv1],
      ),
    );
    expect(rows[0]?.partial_text).toBeNull();
  });

  it('formats thousands the Indonesian way', async () => {
    const { rows } = await db.client.query(
      `SELECT format_id_integer(0) AS a, format_id_integer(999) AS b, format_id_integer(1200) AS c,
              format_id_integer(1234567) AS d`,
    );
    expect(rows[0]).toEqual({ a: '0', b: '999', c: '1.200', d: '1.234.567' });
  });
});

describe('v_findings', () => {
  it('has one row per finding with the area, sub-area and family names', async () => {
    const { rows } = await db.as('m100_report', (c) =>
      c.query<{ qty: number }>(
        `SELECT inspection_type, area_name, sub_area_name, family_name, defect_id, defect_name, severity, qty, counting_rule
           FROM v_findings WHERE submission_id = $1 ORDER BY first_recorded_at`,
        [example],
      ),
    );
    expect(rows).toHaveLength(FINDINGS.length);
    expect(rows[0]).toEqual({
      inspection_type: 'REWORK',
      area_name: 'TOE',
      sub_area_name: 'TOE TIP',
      family_name: 'BONDING',
      defect_id: 'D001',
      defect_name: 'BOND GAP',
      severity: 'MINOR',
      qty: 2,
      counting_rule: 'ADR-008',
    });
    expect(rows.reduce((sum, r) => sum + r.qty, 0)).toBe(11);
  });
});

describe('v_defect_totals and v_top5 (AC-05.1)', () => {
  it('ranks like rankDefects() in packages/shared: quantity, severity, first recorded', async () => {
    const { rows } = await db.as('m100_report', (c) =>
      c.query<{ defect_id: string; qty: number; rank_in_submission: number; has_photo: boolean }>(
        `SELECT defect_id, qty, rank_in_submission, has_photo FROM v_defect_totals
          WHERE submission_id = $1 ORDER BY rank_in_submission`,
        [example],
      ),
    );
    const expected = rankDefects(FINDINGS, (id) => defectOf(id).severity);
    expect(rows.map((r) => r.defect_id)).toEqual(expected.map((d) => d.defectId));
    expect(rows.map((r) => r.defect_id)).toEqual([
      'D001',
      'D002',
      'D007',
      'D004',
      'D003',
      'D005',
      'D006',
    ]);
    expect(rows.map((r) => r.qty)).toEqual([3, 2, 2, 1, 1, 1, 1]);
    expect(rows.map((r) => r.rank_in_submission)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rows.map((r) => r.has_photo)).toEqual([true, true, true, true, true, false, false]);
  });

  it('v_top5 keeps ranks 1 to 5 only', async () => {
    const { rows } = await db.as('m100_report', (c) =>
      c.query<{ defect_id: string }>(
        'SELECT defect_id FROM v_top5 WHERE submission_id = $1 ORDER BY rank_in_submission',
        [example],
      ),
    );
    expect(rows.map((r) => r.defect_id)).toEqual(TOP5);
  });

  it('has no rows for a submission without findings', async () => {
    const { rowCount } = await db.as('m100_report', (c) =>
      c.query('SELECT 1 FROM v_defect_totals WHERE submission_id = $1', [lv1]),
    );
    expect(rowCount).toBe(0);
  });
});
