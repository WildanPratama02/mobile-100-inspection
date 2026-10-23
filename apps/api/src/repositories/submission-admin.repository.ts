/**
 * The admin's read side of the submissions (doc 04 §8, doc 05 §20.3, AC-14.4): the filtered list, one submission
 * with its findings and photos, a photo row, and the batches of the CSV export. Read only: nothing here writes, and
 * the trigger and the grants refuse any change anyway (BR-07). Rows come from `v_submissions` (doc 02 §8), so the
 * admin app and the reporting tools see the same values.
 */
import type { Classification, DefectId, InspectionType, PsiLevel } from '@m100/shared';
import type { Database, Queryable } from '../db/database';

export const SUBMISSION_ADMIN_REPOSITORY = Symbol('SubmissionAdminRepository');

/** Filters of the list and the export (doc 04 §10 A12). Every field is optional; together they all apply. */
export interface SubmissionFilter {
  /** `YYYY-MM-DD`, inclusive, on `inspection_date` (the WIB date of `sealed_at`). */
  from?: string;
  to?: string;
  /** Exact. */
  factory?: string;
  cell?: string;
  username?: string;
  /** Part of the PO number, ignoring case. */
  po?: string;
}

/** One row of `v_submissions` with the bookkeeping columns of `submissions`. */
export interface SubmissionRow {
  id: string;
  displayNo: number;
  sealedAt: Date;
  receivedAt: Date;
  /** `YYYY-MM-DD`. */
  inspectionDate: string;
  appVersion: string | null;
  username: string;
  level: PsiLevel;
  factory: string;
  cell: string;
  po: string;
  article: string;
  model: string;
  destination: string;
  orderQty: number;
  podd: string | null;
  crd: string | null;
  partialNo: number | null;
  partialQty: number | null;
  /** `P1 1.200 OF 10.002`, or `null` when the PO is not partial. */
  partialText: string | null;
  qtyRework: number;
  qtyBGradeInspections: number;
  qtyNoDefect: number;
  qtyInspection: number;
  qtyAGrade: number;
  qtyBGrade: number;
  qtyDefect: number;
  /** Fractions as stored, 5 decimals with a dot (`0.60000`). */
  rft: string;
  defectRate: string;
  photoCount: number;
  countingRule: string;
}

export interface SubmissionFindingRow {
  submissionId: string;
  inspectionType: InspectionType;
  areaId: string;
  areaName: string;
  subAreaId: string;
  subAreaName: string;
  familyId: string;
  familyName: string;
  defectId: DefectId;
  /** Snapshot of the defect at write time. */
  defectName: string;
  severity: Classification;
  qty: number;
  firstRecordedAt: Date;
}

export interface SubmissionPhotoRow {
  id: number;
  submissionId: string;
  defectId: DefectId;
  objectKey: string;
  sizeBytes: number;
}

/** Where an export batch continues: after this row of the list order. */
export interface ExportCursor {
  /** `sealed_at` as the database printed it, so the comparison keeps its full precision. */
  sealedAtKey: string;
  displayNo: number;
}

export interface SubmissionAdminRepository {
  /** One page of the filtered list, newest first (`sealed_at`, then `display_no`). */
  list(
    filter: SubmissionFilter,
    page: { offset: number; limit: number },
    q?: Queryable,
  ): Promise<SubmissionRow[]>;
  count(filter: SubmissionFilter, q?: Queryable): Promise<number>;
  findById(id: string, q?: Queryable): Promise<SubmissionRow | null>;
  /** The findings of these submissions, in the order the PSI first tapped them (the tablet history). */
  findings(submissionIds: readonly string[], q?: Queryable): Promise<SubmissionFindingRow[]>;
  /** The photo rows of these submissions, by defect. */
  photos(submissionIds: readonly string[], q?: Queryable): Promise<SubmissionPhotoRow[]>;
  photo(id: number, q?: Queryable): Promise<SubmissionPhotoRow | null>;
  /**
   * Up to `limit` rows of the filtered list in the list's order, after `cursor`; with each row the cursor of the
   * row itself, to continue from the last one.
   */
  exportBatch(
    filter: SubmissionFilter,
    cursor: ExportCursor | null,
    limit: number,
    q?: Queryable,
  ): Promise<(SubmissionRow & { cursor: ExportCursor })[]>;
}

const COLUMNS = `
  v.id, v.display_no AS "displayNo", s.sealed_at AS "sealedAt", s.received_at AS "receivedAt",
  to_char(v.inspection_date, 'YYYY-MM-DD') AS "inspectionDate", s.app_version AS "appVersion",
  v.username, v.level, v.factory, v.cell, v.po, v.article, v.model, v.destination, v.order_qty AS "orderQty",
  to_char(v.podd, 'YYYY-MM-DD') AS podd, to_char(v.crd, 'YYYY-MM-DD') AS crd,
  v.partial_no AS "partialNo", v.partial_qty AS "partialQty", v.partial_text AS "partialText",
  v.qty_rework AS "qtyRework", v.qty_bgrade_inspections AS "qtyBGradeInspections",
  v.qty_no_defect AS "qtyNoDefect", v.qty_inspection AS "qtyInspection", v.qty_a_grade AS "qtyAGrade",
  v.qty_b_grade AS "qtyBGrade", v.qty_defect AS "qtyDefect", v.rft::text AS rft,
  v.defect_rate::text AS "defectRate", v.photo_count AS "photoCount", v.counting_rule AS "countingRule"`;
const FROM = `FROM v_submissions v JOIN submissions s ON s.id = v.id`;
const ORDER = `ORDER BY s.sealed_at DESC, v.display_no DESC`;

type RawRow = Omit<SubmissionRow, 'displayNo'> & { displayNo: string };

/** `display_no` is a bigint, which `pg` hands over as text; it stays far below 2^53. */
const toRow = ({ displayNo, ...rest }: RawRow): SubmissionRow => ({
  ...rest,
  displayNo: Number(displayNo),
});

/** The `WHERE` of a filter; its values are appended to `params`. */
function where(filter: SubmissionFilter, params: unknown[]): string[] {
  const clauses: string[] = [];
  const add = (value: string | undefined, clause: (p: string) => string) => {
    if (value === undefined) return;
    params.push(value);
    clauses.push(clause(`$${params.length}`));
  };
  add(filter.from, (p) => `v.inspection_date >= ${p}::date`);
  add(filter.to, (p) => `v.inspection_date <= ${p}::date`);
  add(filter.factory, (p) => `v.factory = ${p}`);
  add(filter.cell, (p) => `v.cell = ${p}`);
  add(filter.username, (p) => `v.username = ${p}`);
  // strpos, not LIKE: a `%` or `_` the admin types is matched as itself.
  add(filter.po, (p) => `strpos(lower(v.po), lower(${p})) > 0`);
  return clauses;
}

const whereSql = (clauses: readonly string[]) =>
  clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

export class PgSubmissionAdminRepository implements SubmissionAdminRepository {
  constructor(private readonly db: Database) {}

  async list(
    filter: SubmissionFilter,
    { offset, limit }: { offset: number; limit: number },
    q: Queryable = this.db,
  ): Promise<SubmissionRow[]> {
    const params: unknown[] = [];
    const clauses = where(filter, params);
    params.push(limit, offset);
    const { rows } = await q.query<RawRow>(
      `SELECT ${COLUMNS} ${FROM} ${whereSql(clauses)} ${ORDER}
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows.map(toRow);
  }

  async count(filter: SubmissionFilter, q: Queryable = this.db): Promise<number> {
    const params: unknown[] = [];
    const clauses = where(filter, params);
    const { rows } = await q.query<{ n: number }>(
      `SELECT count(*)::integer AS n ${FROM} ${whereSql(clauses)}`,
      params,
    );
    return rows[0]!.n;
  }

  async findById(id: string, q: Queryable = this.db): Promise<SubmissionRow | null> {
    const { rows } = await q.query<RawRow>(`SELECT ${COLUMNS} ${FROM} WHERE v.id = $1`, [id]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async findings(
    submissionIds: readonly string[],
    q: Queryable = this.db,
  ): Promise<SubmissionFindingRow[]> {
    if (submissionIds.length === 0) return [];
    const { rows } = await q.query<SubmissionFindingRow>(
      `SELECT f.submission_id AS "submissionId", f.inspection_type AS "inspectionType",
              f.area_id AS "areaId", a.name AS "areaName", f.sub_area_id AS "subAreaId",
              sa.name AS "subAreaName", f.family_id AS "familyId", fam.name AS "familyName",
              f.defect_id AS "defectId", f.defect_name AS "defectName", f.severity, f.qty,
              f.first_recorded_at AS "firstRecordedAt"
         FROM submission_findings f
         JOIN areas a ON a.id = f.area_id
         JOIN sub_areas sa ON sa.id = f.sub_area_id
         JOIN families fam ON fam.id = f.family_id
        WHERE f.submission_id = ANY($1::uuid[])
        ORDER BY f.submission_id, f.first_recorded_at, f.id`,
      [submissionIds],
    );
    return rows;
  }

  async photos(
    submissionIds: readonly string[],
    q: Queryable = this.db,
  ): Promise<SubmissionPhotoRow[]> {
    if (submissionIds.length === 0) return [];
    const { rows } = await q.query<RawPhotoRow>(
      `SELECT ${PHOTO_COLUMNS} FROM submission_photos
        WHERE submission_id = ANY($1::uuid[]) ORDER BY submission_id, defect_id`,
      [submissionIds],
    );
    return rows.map(toPhotoRow);
  }

  async photo(id: number, q: Queryable = this.db): Promise<SubmissionPhotoRow | null> {
    const { rows } = await q.query<RawPhotoRow>(
      `SELECT ${PHOTO_COLUMNS} FROM submission_photos WHERE id = $1::bigint`,
      [id],
    );
    return rows[0] ? toPhotoRow(rows[0]) : null;
  }

  async exportBatch(
    filter: SubmissionFilter,
    cursor: ExportCursor | null,
    limit: number,
    q: Queryable = this.db,
  ): Promise<(SubmissionRow & { cursor: ExportCursor })[]> {
    const params: unknown[] = [];
    const clauses = where(filter, params);
    if (cursor) {
      params.push(cursor.sealedAtKey, cursor.displayNo);
      clauses.push(
        `(s.sealed_at, v.display_no) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`,
      );
    }
    params.push(limit);
    const { rows } = await q.query<RawRow & { sealedAtKey: string }>(
      `SELECT ${COLUMNS}, s.sealed_at::text AS "sealedAtKey" ${FROM} ${whereSql(clauses)} ${ORDER}
        LIMIT $${params.length}`,
      params,
    );
    return rows.map(({ sealedAtKey, ...raw }) => {
      const row = toRow(raw);
      return { ...row, cursor: { sealedAtKey, displayNo: row.displayNo } };
    });
  }
}

const PHOTO_COLUMNS = `id::text AS id, submission_id AS "submissionId", defect_id AS "defectId",
                       object_key AS "objectKey", size_bytes AS "sizeBytes"`;

type RawPhotoRow = Omit<SubmissionPhotoRow, 'id'> & { id: string };
const toPhotoRow = ({ id, ...rest }: RawPhotoRow): SubmissionPhotoRow => ({
  ...rest,
  id: Number(id),
});
