import { createHash, randomUUID } from 'node:crypto';
import { computeTotals, type DefectId, type InspectionCounts } from '@m100/shared';
import { Database } from '../db/database';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { DEVICE_ID, FINDINGS, seedMasterData } from '../testing/schema-fixtures';
import {
  type NewSubmission,
  PgSubmissionRepository,
  SubmissionTotalsMismatch,
} from './submission.repository';

let db: TestDatabase;
let repo: PgSubmissionRepository;

const sha = (text: string): Buffer => createHash('sha256').update(text).digest();

/** The Top 5 of FINDINGS (see schema-fixtures): D001, D002, D007, D004, D003. */
const TOP5: DefectId[] = ['D001', 'D002', 'D007', 'D004', 'D003'];

/** The doc 02 §9 example: 10 REWORK pairs with 8 defects, 2 B-GRADE pairs with 3, 18 NO DEFECT. */
function newSubmission(overrides: Partial<NewSubmission> = {}): NewSubmission {
  const id = overrides.id ?? randomUUID();
  const counts: InspectionCounts = overrides.counts ?? { rework: 10, bGrade: 2, noDefect: 18 };
  const findings = overrides.findings ?? FINDINGS;
  return {
    id,
    payloadSha256: sha(`payload ${id}`),
    sealedAt: '2026-10-16T17:30:00.000Z',
    inspectionDate: '2026-10-17',
    appVersion: '1.0.0',
    deviceId: DEVICE_ID,
    username: 'ROIS FATHUR ROHIM',
    level: 'PSI lv.2',
    factory: 'F 3',
    cell: 'F3-10',
    po: '0902028839',
    partial: { number: 1, qty: 1200 },
    counts,
    totals: computeTotals(counts, findings),
    findings,
    photos: TOP5.map((defectId) => ({
      defectId,
      objectKey: `submissions/2026/10/${id}/${defectId}.jpg`,
      sha256: sha(`${id}/${defectId}`),
      sizeBytes: 150_000,
    })),
    ...overrides,
  };
}

async function rowCounts(
  id: string,
): Promise<{ submissions: number; findings: number; photos: number }> {
  const { rows } = await db.client.query<{ submissions: number; findings: number; photos: number }>(
    `SELECT (SELECT count(*) FROM submissions WHERE id = $1)::integer AS submissions,
            (SELECT count(*) FROM submission_findings WHERE submission_id = $1)::integer AS findings,
            (SELECT count(*) FROM submission_photos WHERE submission_id = $1)::integer AS photos`,
    [id],
  );
  return rows[0]!;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrated: true });
  await db.as('m100_migrate', seedMasterData, { commit: true });
  repo = new PgSubmissionRepository(new Database(db.pool('m100_app')));
});
afterAll(async () => {
  await db?.drop();
});

describe('PgSubmissionRepository.write (doc 02 §6.1 step 4)', () => {
  const first = newSubmission();

  it('writes the submission, its findings and photo rows in one go and answers with the totals', async () => {
    const result = await repo.write(first);
    expect(result.written).toBe(true);
    expect(result.submission).toMatchObject({
      id: first.id,
      totals: {
        qtyInspection: 30,
        qtyAGrade: 18,
        qtyBGrade: 3,
        qtyDefect: 11,
        rft: 0.6,
        defectRate: 0.36667,
      },
    });
    expect(result.submission.payloadSha256.equals(first.payloadSha256)).toBe(true);
    expect(result.submission.displayNo).toBeGreaterThanOrEqual(1);
    expect(result.submission.receivedAt).toBeInstanceOf(Date);
    expect(await rowCounts(first.id)).toEqual({ submissions: 1, findings: 8, photos: 5 });
  });

  it('copies the PO fields from pos and the defect name and severity from defects', async () => {
    const { rows } = await db.client.query(
      `SELECT article, model, destination, order_qty, to_char(podd, 'YYYY-MM-DD') AS podd, crd,
              to_char(inspection_date, 'YYYY-MM-DD') AS inspection_date, partial_no, partial_qty,
              qty_rework, qty_bgrade_inspections, qty_no_defect, photo_count, device_id
         FROM submissions WHERE id = $1`,
      [first.id],
    );
    expect(rows[0]).toEqual({
      article: 'IH1234',
      model: 'RUNNER X',
      destination: 'JAPAN',
      order_qty: 10002,
      podd: null,
      crd: null,
      inspection_date: '2026-10-17',
      partial_no: 1,
      partial_qty: 1200,
      qty_rework: 10,
      qty_bgrade_inspections: 2,
      qty_no_defect: 18,
      photo_count: 5,
      device_id: DEVICE_ID,
    });
    const findings = await db.client.query(
      `SELECT defect_id, defect_name, severity FROM submission_findings
        WHERE submission_id = $1 AND inspection_type = 'REWORK' AND defect_id IN ('D002', 'D004')
        ORDER BY defect_id`,
      [first.id],
    );
    expect(findings.rows).toEqual([
      { defect_id: 'D002', defect_name: 'OVER CEMENTING', severity: 'MAJOR' },
      { defect_id: 'D004', defect_name: 'Broken Stitching', severity: 'CRITICAL' },
    ]);
  });

  it('finds a written submission by its UUID', async () => {
    const found = await repo.findById(first.id);
    expect(found?.totals.qtyDefect).toBe(11);
    expect(found?.payloadSha256.equals(first.payloadSha256)).toBe(true);
    expect(await repo.findById(randomUUID())).toBeNull();
  });

  it('returns the stored submission for a repeated UUID and writes nothing more', async () => {
    const original = await repo.findById(first.id);
    const again = await repo.write({ ...first, payloadSha256: sha('other bytes') });
    expect(again.written).toBe(false);
    // The stored hash, so the caller can answer 200 or 409 SUBMISSION_UUID_REUSED.
    expect(again.submission).toEqual(original);
    expect(await rowCounts(first.id)).toEqual({ submissions: 1, findings: 8, photos: 5 });
  });

  it('writes one submission when the same UUID arrives in parallel', async () => {
    const s = newSubmission();
    const results = await Promise.all(Array.from({ length: 6 }, () => repo.write(s)));
    expect(results.filter((r) => r.written)).toHaveLength(1);
    expect(new Set(results.map((r) => r.submission.displayNo)).size).toBe(1);
    expect(await rowCounts(s.id)).toEqual({ submissions: 1, findings: 8, photos: 5 });
  });

  it.each([
    ['Qty Defect', { qtyDefect: 12 }],
    ['Qty B-Grade', { qtyBGrade: 2 }],
  ])(
    'rolls everything back when %s disagrees with the findings (doc 02 §6.3)',
    async (_, wrong) => {
      const s = newSubmission();
      const bad = { ...s, totals: { ...s.totals, ...wrong } };
      await expect(repo.write(bad)).rejects.toBeInstanceOf(SubmissionTotalsMismatch);
      expect(await rowCounts(s.id)).toEqual({ submissions: 0, findings: 0, photos: 0 });
      // The retry with correct totals then writes normally.
      expect((await repo.write(s)).written).toBe(true);
    },
  );

  it('writes nothing when a finding names a defect that does not exist', async () => {
    const s = newSubmission({
      findings: [{ ...FINDINGS[0]!, defectId: 'D098', qty: 11 }],
      photos: [],
    });
    await expect(repo.write({ ...s, totals: { ...s.totals, qtyBGrade: 0 } })).rejects.toThrow(
      'name an unknown defect',
    );
    expect(await rowCounts(s.id)).toEqual({ submissions: 0, findings: 0, photos: 0 });
  });

  it('writes nothing for a PO that is not in pos', async () => {
    const s = newSubmission({ po: '0000000000' });
    await expect(repo.write(s)).rejects.toThrow('PO 0000000000 is not in pos');
    expect(await rowCounts(s.id)).toEqual({ submissions: 0, findings: 0, photos: 0 });
  });

  it('writes a PSI lv.1 submission of NO DEFECT pairs only, without partial and photos', async () => {
    const s = newSubmission({
      level: 'PSI lv.1',
      counts: { rework: 0, bGrade: 0, noDefect: 5 },
      findings: [],
      photos: [],
      partial: null,
    });
    const result = await repo.write(s);
    expect(result.submission.totals).toEqual({
      qtyInspection: 5,
      qtyAGrade: 5,
      qtyBGrade: 0,
      qtyDefect: 0,
      rft: 1,
      defectRate: 0,
    });
    expect(await rowCounts(s.id)).toEqual({ submissions: 1, findings: 0, photos: 0 });
  });

  it('refuses a submission with Qty Inspection 0 and writes nothing', async () => {
    const s = newSubmission({
      counts: { rework: 0, bGrade: 0, noDefect: 0 },
      findings: [],
      photos: [],
    });
    await expect(repo.write(s)).rejects.toThrow('Qty Inspection is 0');
    expect(await rowCounts(s.id)).toEqual({ submissions: 0, findings: 0, photos: 0 });
  });

  it('keeps the snapshot when master data is edited afterwards', async () => {
    await db.as(
      'm100_migrate',
      async (c) => {
        await c.query(
          `UPDATE defects SET name = 'OVER CEMENTING (renamed)', severity = 'MINOR' WHERE id = 'D002'`,
        );
        await c.query(`UPDATE pos SET model = 'RUNNER Y', order_qty = 5 WHERE po = '0902028839'`);
      },
      { commit: true },
    );
    const { rows } = await db.client.query(
      `SELECT s.model, s.order_qty, f.defect_name, f.severity
         FROM submissions s JOIN submission_findings f ON f.submission_id = s.id
        WHERE s.id = $1 AND f.defect_id = 'D002'`,
      [first.id],
    );
    expect(rows).toEqual([
      { model: 'RUNNER X', order_qty: 10002, defect_name: 'OVER CEMENTING', severity: 'MAJOR' },
    ]);
  });
});
