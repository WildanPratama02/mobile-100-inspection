/**
 * Test helper: a little master data and a valid submission row for the schema tests. Values are invented; only the
 * shapes follow doc 02.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ClientBase } from 'pg';
import type { Classification, DefectId, Finding } from '@m100/shared';

export const DEVICE_ID = '9b0f9d6e-1c1a-4f57-9d55-3c1f2b6a7e01';

export const DEFECTS: readonly { id: DefectId; name: string; severity: Classification }[] = [
  { id: 'D001', name: 'BOND GAP', severity: 'MINOR' },
  { id: 'D002', name: 'OVER CEMENTING', severity: 'MAJOR' },
  { id: 'D003', name: 'THREAD END', severity: 'MINOR' },
  { id: 'D004', name: 'Broken Stitching', severity: 'CRITICAL' },
  { id: 'D005', name: 'WRINKLE', severity: 'MINOR' },
  { id: 'D006', name: 'DIRTY (Stain)', severity: 'MINOR' },
  { id: 'D007', name: 'COLOR MIGRATION', severity: 'MINOR' },
];

/** Two areas with one sub-area each, one family, the defects above mapped in both, one PO and one device. */
export async function seedMasterData(db: ClientBase): Promise<void> {
  await db.query(`
    INSERT INTO areas (id, name, sort) VALUES ('A01', 'TOE', 1), ('A02', 'VAMP', 2);
    INSERT INTO sub_areas (id, area_id, name, sort) VALUES ('SA01', 'A01', 'TOE TIP', 1), ('SA02', 'A02', 'VAMP CENTER', 2);
    INSERT INTO families (id, name) VALUES ('F01', 'BONDING');
    INSERT INTO pos (po, article, model, destination, order_qty, source)
      VALUES ('0902028839', 'IH1234', 'RUNNER' || U&'\\00A0' || 'X', 'JAPAN', 10002, 'import:ALL_PO_MASTER.csv');`);
  for (const d of DEFECTS) {
    await db.query('INSERT INTO defects (id, name, severity) VALUES ($1, $2, $3)', [
      d.id,
      d.name,
      d.severity,
    ]);
    for (const [area, sub] of [
      ['A01', 'SA01'],
      ['A02', 'SA02'],
    ] as const) {
      await db.query(
        `INSERT INTO area_map (id, area_id, sub_area_id, family_id, defect_id) VALUES ($1, $2, $3, 'F01', $4)`,
        [`MAP-${d.id}-${area}`, area, sub, d.id],
      );
    }
  }
  await db.query(`INSERT INTO devices (id, label, key_sha256) VALUES ($1, 'Tablet F3-01', $2)`, [
    DEVICE_ID,
    createHash('sha256').update('test device key').digest(),
  ]);
}

export type SubmissionRow = Record<string, unknown>;

/** The doc 02 §9 example: 10 REWORK pairs with 8 defects, 2 B-GRADE pairs with 3 defects, 18 NO DEFECT. */
export function submissionRow(overrides: SubmissionRow = {}): SubmissionRow {
  return {
    id: randomUUID(),
    payload_sha256: createHash('sha256').update(randomUUID()).digest(),
    sealed_at: '2026-10-16T17:30:00.000Z', // 00:30 WIB on 17 Oct
    inspection_date: '2026-10-17',
    app_version: '1.0.0',
    device_id: DEVICE_ID,
    username: 'ROIS FATHUR ROHIM',
    level: 'PSI lv.2',
    factory: 'F 3',
    cell: 'F3-10',
    po: '0902028839',
    article: 'IH1234',
    model: 'RUNNER X',
    destination: 'JAPAN',
    order_qty: 10002,
    podd: '2026-01-12',
    crd: null,
    partial_no: 1,
    partial_qty: 1200,
    qty_rework: 10,
    qty_bgrade_inspections: 2,
    qty_no_defect: 18,
    qty_inspection: 30,
    qty_a_grade: 18,
    qty_b_grade: 3,
    qty_defect: 11,
    rft: '0.60000',
    defect_rate: '0.36667',
    photo_count: 5,
    ...overrides,
  };
}

export async function insertSubmission(db: ClientBase, row: SubmissionRow): Promise<string> {
  const columns = Object.keys(row);
  await db.query(
    `INSERT INTO submissions (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  );
  return String(row.id);
}

const AT = (second: number): string => `2026-10-16T17:${String(second).padStart(2, '0')}:00.000Z`;

/**
 * Findings of the doc 02 §9 example (REWORK Σ 8, B-GRADE Σ 3) with ties on quantity, so the ranking needs severity
 * and then the first tap: D001 3, D002 2 MAJOR, D007 2 MINOR, D004 1 CRITICAL, D003 1 (t3), D005 1 (t6), D006 1 (t7).
 */
export const FINDINGS: readonly Finding[] = [
  {
    inspectionType: 'REWORK',
    areaId: 'A01',
    subAreaId: 'SA01',
    familyId: 'F01',
    defectId: 'D001',
    qty: 2,
    firstRecordedAt: AT(1),
  },
  {
    inspectionType: 'REWORK',
    areaId: 'A01',
    subAreaId: 'SA01',
    familyId: 'F01',
    defectId: 'D002',
    qty: 2,
    firstRecordedAt: AT(2),
  },
  {
    inspectionType: 'REWORK',
    areaId: 'A02',
    subAreaId: 'SA02',
    familyId: 'F01',
    defectId: 'D003',
    qty: 1,
    firstRecordedAt: AT(3),
  },
  {
    inspectionType: 'REWORK',
    areaId: 'A02',
    subAreaId: 'SA02',
    familyId: 'F01',
    defectId: 'D004',
    qty: 1,
    firstRecordedAt: AT(4),
  },
  {
    inspectionType: 'REWORK',
    areaId: 'A01',
    subAreaId: 'SA01',
    familyId: 'F01',
    defectId: 'D005',
    qty: 1,
    firstRecordedAt: AT(6),
  },
  {
    inspectionType: 'REWORK',
    areaId: 'A01',
    subAreaId: 'SA01',
    familyId: 'F01',
    defectId: 'D006',
    qty: 1,
    firstRecordedAt: AT(7),
  },
  {
    inspectionType: 'B-GRADE',
    areaId: 'A02',
    subAreaId: 'SA02',
    familyId: 'F01',
    defectId: 'D001',
    qty: 1,
    firstRecordedAt: AT(8),
  },
  {
    inspectionType: 'B-GRADE',
    areaId: 'A01',
    subAreaId: 'SA01',
    familyId: 'F01',
    defectId: 'D007',
    qty: 2,
    firstRecordedAt: AT(9),
  },
];

export function defectOf(id: DefectId): { id: DefectId; name: string; severity: Classification } {
  const found = DEFECTS.find((d) => d.id === id);
  if (!found) throw new Error(`Unknown test defect ${id}`);
  return found;
}

export async function insertFinding(
  db: ClientBase,
  submissionId: string,
  f: Finding,
): Promise<void> {
  const d = defectOf(f.defectId);
  await db.query(
    `INSERT INTO submission_findings
       (submission_id, inspection_type, area_id, sub_area_id, family_id, defect_id, defect_name, severity, qty, first_recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      submissionId,
      f.inspectionType,
      f.areaId,
      f.subAreaId,
      f.familyId,
      f.defectId,
      d.name,
      d.severity,
      f.qty,
      f.firstRecordedAt,
    ],
  );
}

export async function insertPhoto(
  db: ClientBase,
  submissionId: string,
  defectId: DefectId,
): Promise<void> {
  await db.query(
    `INSERT INTO submission_photos (submission_id, defect_id, object_key, sha256, size_bytes)
     VALUES ($1, $2, $3, $4, 150000)`,
    [
      submissionId,
      defectId,
      `submissions/2026/10/${submissionId}/${defectId}.jpg`,
      createHash('sha256').update(`${submissionId}/${defectId}`).digest(),
    ],
  );
}
