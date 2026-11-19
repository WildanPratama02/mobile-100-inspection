/**
 * Revisions of a submission (ADR-024, doc 02 §4.4, §6.5): reading a version (the original, a revision, or the
 * effective one), writing a correction inside the caller's transaction, the history, and the reads the tablet's
 * correction endpoints need (doc 04 §3.4). Rows are only ever inserted; the trigger and the grants refuse any change.
 */
import {
  type Classification,
  type CountingRule,
  type DefectId,
  type Finding,
  type PhotoRule,
  type PsiLevel,
  type RevisionChanges,
  type SubmissionVersion,
  toWibIso,
  type Totals,
  type VersionCounts,
} from '@m100/shared';
import type { Database, Queryable } from '../db/database';

export const SUBMISSION_REVISION_REPOSITORY = Symbol('SubmissionRevisionRepository');

/** A finding of a version with the snapshot of its defect. */
export interface VersionFinding extends Finding {
  defectName: string;
  severity: Classification;
  areaName: string;
  subAreaName: string;
  familyName: string;
}

/** A photo row of a version: `submission_photos` (`original`) or `submission_revision_photos` (`revision`). */
export interface VersionPhoto {
  source: 'original' | 'revision';
  id: number;
  defectId: DefectId;
  objectKey: string;
  /** Hex. */
  sha256: string;
  sizeBytes: number;
}

/** One version with what never changes between versions. */
export interface VersionRecord {
  submissionId: string;
  displayNo: number;
  level: PsiLevel;
  countingRule: CountingRule;
  photoRule: PhotoRule | null;
  /** The PSI who sent the original; owns the corrections on the tablet (doc 04 §3.4). */
  originalUsername: string;
  receivedAt: Date;
  appVersion: string | null;
  /** 0 for the original. */
  revisionNo: number;
  /** The newest revision of the submission (0 without any). */
  latestRevisionNo: number;
  correctedAt: Date | null;
  correctedBy: string | null;
  correctionReason: string | null;
  version: Omit<SubmissionVersion, 'findings'> & { findings: VersionFinding[] };
  totals: {
    qtyInspection: number;
    qtyAGrade: number;
    qtyBGrade: number;
    qtyDefect: number;
    rft: number;
    defectRate: number;
  };
  photos: VersionPhoto[];
}

/** A stored revision, for a repeated request (doc 02 §6.5 step 1). */
export interface StoredRevision {
  id: string;
  submissionId: string;
  revisionNo: number;
  /** Hex. */
  requestSha256: string;
}

export interface NewRevisionPhoto {
  defectId: DefectId;
  objectKey: string;
  /** 32 bytes. */
  sha256: Buffer;
  sizeBytes: number;
}

/** A correction ready to write: the version, its totals (from `versionTotals`) and the bookkeeping. */
export interface NewRevision {
  id: string;
  submissionId: string;
  revisionNo: number;
  requestSha256: Buffer;
  adminId: number;
  adminUsername: string;
  reason: string;
  version: SubmissionVersion;
  /** Qty Inspection ≥ 1, so both rates are numbers. */
  totals: Totals;
  /** Defect name and severity are copied from `defects` inside the transaction. */
  findings: readonly Finding[];
  photos: readonly NewRevisionPhoto[];
  changes: RevisionChanges;
}

export interface HistoryEntry {
  revisionNo: number;
  at: Date;
  by: string;
  reason: string | null;
  changes: RevisionChanges | null;
}

/** The in-transaction re-check found totals that disagree with the revision's rows: a server bug. */
export class RevisionTotalsMismatch extends Error {
  constructor(
    readonly revisionId: string,
    readonly detail: Record<string, number>,
  ) {
    super(`Revision ${revisionId}: stored totals disagree with its rows ${JSON.stringify(detail)}`);
    this.name = 'RevisionTotalsMismatch';
  }
}

export interface SubmissionRevisionRepository {
  /** `null` when the submission does not exist; else its newest revision number (0 without any). */
  latestRevisionNo(submissionId: string, q?: Queryable): Promise<number | null>;
  /**
   * Version `revisionNo` (0 = the original), or the effective one when it is `undefined`; `null` when the
   * submission or that revision does not exist.
   */
  findVersion(
    submissionId: string,
    revisionNo?: number,
    q?: Queryable,
  ): Promise<VersionRecord | null>;
  findRevision(revisionId: string, q?: Queryable): Promise<StoredRevision | null>;
  /**
   * Takes a transaction lock on the submission so corrections of one submission are written one after the other;
   * returns its newest revision number, or `null` when it does not exist. In the caller's transaction.
   */
  lockForRevision(submissionId: string, tx: Queryable): Promise<number | null>;
  /**
   * Inserts the revision with its findings and photo rows and re-checks the sums, in the caller's transaction.
   * `false` when a revision with this id already exists. Throws `RevisionTotalsMismatch` on a bad re-check.
   */
  insert(revision: NewRevision, tx: Queryable): Promise<boolean>;
  /** Revision 0 (the PSI's submission) and every correction, oldest first. */
  history(submissionId: string, q?: Queryable): Promise<HistoryEntry[]>;
  /** The effective version of each of `ids` that has a revision and whose original PSI is `username`. */
  newestFor(ids: readonly string[], username: string, q?: Queryable): Promise<VersionRecord[]>;
  /** A photo of the effective version, when that version is `revisionNo` and the original PSI is `username`. */
  correctionPhoto(
    submissionId: string,
    revisionNo: number,
    defectId: string,
    username: string,
    q?: Queryable,
  ): Promise<VersionPhoto | null>;
  /** A `submission_revision_photos` row (admin photo endpoint). */
  revisionPhoto(id: number, q?: Queryable): Promise<VersionPhoto | null>;
}

interface HeaderRow {
  submissionId: string;
  displayNo: string;
  level: PsiLevel;
  countingRule: CountingRule;
  photoRule: PhotoRule | null;
  originalUsername: string;
  receivedAt: Date;
  appVersion: string | null;
  revisionNo: number;
  revisionId: string | null;
  latestRevisionNo: number;
  correctedAt: Date | null;
  correctedBy: string | null;
  correctionReason: string | null;
  sealedAt: Date;
  username: string;
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
  qtyRework: number;
  qtyBGradeInspections: number;
  qtyReworkApproved: number | null;
  qtyNoDefect: number | null;
  qtyInspection: number;
  qtyAGrade: number;
  qtyBGrade: number;
  qtyDefect: number;
  rft: string;
  defectRate: string;
}

/** The version columns, read from `x` (the original row or a revision row) and the parent `s`. */
const versionColumns = (x: string) => `
  s.id AS "submissionId", s.display_no AS "displayNo", s.level, s.counting_rule AS "countingRule",
  s.photo_rule AS "photoRule", s.username AS "originalUsername", s.received_at AS "receivedAt",
  s.app_version AS "appVersion",
  (SELECT coalesce(max(m.revision_no), 0) FROM submission_revisions m WHERE m.submission_id = s.id)::integer
    AS "latestRevisionNo",
  ${x}.sealed_at AS "sealedAt", ${x}.username, ${x}.factory, ${x}.cell, ${x}.po, ${x}.article, ${x}.model,
  ${x}.destination, ${x}.order_qty AS "orderQty", to_char(${x}.podd, 'YYYY-MM-DD') AS podd,
  to_char(${x}.crd, 'YYYY-MM-DD') AS crd, ${x}.partial_no AS "partialNo", ${x}.partial_qty AS "partialQty",
  ${x}.qty_rework AS "qtyRework", ${x}.qty_bgrade_inspections AS "qtyBGradeInspections",
  ${x}.qty_rework_approved AS "qtyReworkApproved", ${x}.qty_no_defect AS "qtyNoDefect",
  ${x}.qty_inspection AS "qtyInspection", ${x}.qty_a_grade AS "qtyAGrade", ${x}.qty_b_grade AS "qtyBGrade",
  ${x}.qty_defect AS "qtyDefect", ${x}.rft::text AS rft, ${x}.defect_rate::text AS "defectRate"`;

const ORIGINAL_SQL = `SELECT ${versionColumns('s')}, 0 AS "revisionNo", NULL::uuid AS "revisionId",
    NULL::timestamptz AS "correctedAt", NULL::text AS "correctedBy", NULL::text AS "correctionReason"
  FROM submissions s`;
const REVISION_SQL = `SELECT ${versionColumns('r')}, r.revision_no AS "revisionNo", r.id AS "revisionId",
    r.created_at AS "correctedAt", r.admin_username AS "correctedBy", r.reason AS "correctionReason"
  FROM submission_revisions r JOIN submissions s ON s.id = r.submission_id`;

/** The effective version of the submissions matching `where` (on `s`), with its revision when it has one. */
const effectiveSql = (where: string) => `
  SELECT ${versionColumns('v')},
         CASE WHEN r.id IS NULL THEN 0 ELSE r.revision_no END AS "revisionNo", r.id AS "revisionId",
         r.created_at AS "correctedAt", r.admin_username AS "correctedBy", r.reason AS "correctionReason"
    FROM submissions s
    LEFT JOIN LATERAL (
      SELECT * FROM submission_revisions x WHERE x.submission_id = s.id ORDER BY x.revision_no DESC LIMIT 1
    ) r ON true
    CROSS JOIN LATERAL (
      SELECT CASE WHEN r.id IS NULL THEN s.sealed_at ELSE r.sealed_at END AS sealed_at,
             CASE WHEN r.id IS NULL THEN s.username ELSE r.username END AS username,
             CASE WHEN r.id IS NULL THEN s.factory ELSE r.factory END AS factory,
             CASE WHEN r.id IS NULL THEN s.cell ELSE r.cell END AS cell,
             CASE WHEN r.id IS NULL THEN s.po ELSE r.po END AS po,
             CASE WHEN r.id IS NULL THEN s.article ELSE r.article END AS article,
             CASE WHEN r.id IS NULL THEN s.model ELSE r.model END AS model,
             CASE WHEN r.id IS NULL THEN s.destination ELSE r.destination END AS destination,
             CASE WHEN r.id IS NULL THEN s.order_qty ELSE r.order_qty END AS order_qty,
             CASE WHEN r.id IS NULL THEN s.podd ELSE r.podd END AS podd,
             CASE WHEN r.id IS NULL THEN s.crd ELSE r.crd END AS crd,
             CASE WHEN r.id IS NULL THEN s.partial_no ELSE r.partial_no END AS partial_no,
             CASE WHEN r.id IS NULL THEN s.partial_qty ELSE r.partial_qty END AS partial_qty,
             CASE WHEN r.id IS NULL THEN s.qty_rework ELSE r.qty_rework END AS qty_rework,
             CASE WHEN r.id IS NULL THEN s.qty_bgrade_inspections ELSE r.qty_bgrade_inspections END
               AS qty_bgrade_inspections,
             CASE WHEN r.id IS NULL THEN s.qty_rework_approved ELSE r.qty_rework_approved END
               AS qty_rework_approved,
             CASE WHEN r.id IS NULL THEN s.qty_no_defect ELSE r.qty_no_defect END AS qty_no_defect,
             CASE WHEN r.id IS NULL THEN s.qty_inspection ELSE r.qty_inspection END AS qty_inspection,
             CASE WHEN r.id IS NULL THEN s.qty_a_grade ELSE r.qty_a_grade END AS qty_a_grade,
             CASE WHEN r.id IS NULL THEN s.qty_b_grade ELSE r.qty_b_grade END AS qty_b_grade,
             CASE WHEN r.id IS NULL THEN s.qty_defect ELSE r.qty_defect END AS qty_defect,
             CASE WHEN r.id IS NULL THEN s.rft ELSE r.rft END AS rft,
             CASE WHEN r.id IS NULL THEN s.defect_rate ELSE r.defect_rate END AS defect_rate
    ) v
   WHERE ${where}`;

interface FindingRow extends VersionFinding {
  key: string;
}

interface PhotoRow {
  key: string;
  source: 'original' | 'revision';
  id: string;
  defectId: DefectId;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
}

export class PgSubmissionRevisionRepository implements SubmissionRevisionRepository {
  constructor(private readonly db: Database) {}

  async latestRevisionNo(submissionId: string, q: Queryable = this.db): Promise<number | null> {
    const { rows } = await q.query<{ n: number }>(
      `SELECT (SELECT coalesce(max(revision_no), 0) FROM submission_revisions WHERE submission_id = s.id)::integer AS n
         FROM submissions s WHERE s.id = $1::uuid`,
      [submissionId],
    );
    return rows[0]?.n ?? null;
  }

  async findVersion(
    submissionId: string,
    revisionNo?: number,
    q: Queryable = this.db,
  ): Promise<VersionRecord | null> {
    let header: HeaderRow | undefined;
    if (revisionNo === undefined) {
      header = (await q.query<HeaderRow>(effectiveSql('s.id = $1::uuid'), [submissionId])).rows[0];
    } else if (revisionNo === 0) {
      header = (await q.query<HeaderRow>(`${ORIGINAL_SQL} WHERE s.id = $1::uuid`, [submissionId]))
        .rows[0];
    } else {
      header = (
        await q.query<HeaderRow>(
          `${REVISION_SQL} WHERE r.submission_id = $1::uuid AND r.revision_no = $2::integer`,
          [submissionId, revisionNo],
        )
      ).rows[0];
    }
    if (!header) return null;
    const [record] = await this.assemble([header], q);
    return record ?? null;
  }

  async findRevision(revisionId: string, q: Queryable = this.db): Promise<StoredRevision | null> {
    const { rows } = await q.query<StoredRevision>(
      `SELECT id, submission_id AS "submissionId", revision_no AS "revisionNo",
              encode(request_sha256, 'hex') AS "requestSha256"
         FROM submission_revisions WHERE id = $1::uuid`,
      [revisionId],
    );
    return rows[0] ?? null;
  }

  async lockForRevision(submissionId: string, tx: Queryable): Promise<number | null> {
    // A transaction advisory lock, not FOR UPDATE: that needs the UPDATE grant m100_app must not have (BR-07).
    // The unique (submission_id, revision_no) still refuses a second revision with the same number.
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('submission_revision:' || $1::text, 0))",
      [submissionId],
    );
    return this.latestRevisionNo(submissionId, tx);
  }

  async insert(r: NewRevision, tx: Queryable): Promise<boolean> {
    const { totals, version: v } = r;
    if (totals.passRate === null || totals.defectRate === null) {
      throw new Error(`Revision ${r.id}: Qty Inspection is 0, nothing to write`);
    }
    const inserted = await tx.query(
      `INSERT INTO submission_revisions (
         id, submission_id, revision_no, request_sha256, admin_id, admin_username, reason,
         sealed_at, inspection_date, username, factory, cell,
         po, article, model, destination, order_qty, podd, crd, partial_no, partial_qty,
         qty_rework, qty_bgrade_inspections, qty_rework_approved, qty_no_defect,
         qty_inspection, qty_a_grade, qty_b_grade, qty_defect, rft, defect_rate, photo_count, changes)
       VALUES ($1::uuid, $2::uuid, $3::integer, $4::bytea, $5::integer, $6::text, $7::text,
               $8::timestamptz, (($8::timestamptz) AT TIME ZONE 'Asia/Jakarta')::date, $9::text, $10::text, $11::text,
               $12::text, $13::text, $14::text, $15::text, $16::integer, $17::date, $18::date, $19::smallint,
               $20::integer,
               $21::integer, $22::integer, $23::integer, $24::integer,
               $25::integer, $26::integer, $27::integer, $28::integer, $29::numeric, $30::numeric, $31::smallint,
               $32::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        r.id,
        r.submissionId,
        r.revisionNo,
        r.requestSha256,
        r.adminId,
        r.adminUsername,
        r.reason,
        v.sealedAt,
        v.username,
        v.factory,
        v.cell,
        v.po,
        v.article,
        v.model,
        v.destination,
        v.orderQty,
        v.podd,
        v.crd,
        v.partial?.number ?? null,
        v.partial?.qty ?? null,
        v.counts.rework,
        v.counts.bGrade,
        v.counts.reworkApproved ?? 0,
        v.counts.noDefect ?? null,
        totals.qtyInspection,
        totals.qtyAGrade,
        totals.qtyBGrade,
        totals.qtyDefect,
        totals.passRate,
        totals.defectRate,
        r.photos.length,
        JSON.stringify(r.changes),
      ],
    );
    if (inserted.rowCount === 0) return false;

    if (r.findings.length > 0) {
      const f = r.findings;
      const { rowCount } = await tx.query(
        `INSERT INTO submission_revision_findings (revision_id, inspection_type, area_id, sub_area_id, family_id,
                                                   defect_id, defect_name, severity, qty, first_recorded_at)
         SELECT $1::uuid, f.inspection_type, f.area_id, f.sub_area_id, f.family_id, f.defect_id,
                d.name, d.severity, f.qty, f.first_recorded_at
           FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::integer[], $8::timestamptz[])
                AS f (inspection_type, area_id, sub_area_id, family_id, defect_id, qty, first_recorded_at)
           JOIN defects d ON d.id = f.defect_id`,
        [
          r.id,
          f.map((x) => x.inspectionType),
          f.map((x) => x.areaId),
          f.map((x) => x.subAreaId),
          f.map((x) => x.familyId),
          f.map((x) => x.defectId),
          f.map((x) => x.qty),
          f.map((x) => x.firstRecordedAt),
        ],
      );
      if (rowCount !== f.length) {
        throw new Error(`Revision ${r.id}: a finding names an unknown defect`);
      }
    }
    if (r.photos.length > 0) {
      const p = r.photos;
      await tx.query(
        `INSERT INTO submission_revision_photos (revision_id, defect_id, object_key, sha256, size_bytes)
         SELECT $1::uuid, * FROM unnest($2::text[], $3::text[], $4::bytea[], $5::integer[])`,
        [
          r.id,
          p.map((x) => x.defectId),
          p.map((x) => x.objectKey),
          p.map((x) => x.sha256),
          p.map((x) => x.sizeBytes),
        ],
      );
    }
    await recheck(tx, r.id);
    return true;
  }

  async history(submissionId: string, q: Queryable = this.db): Promise<HistoryEntry[]> {
    const { rows } = await q.query<HistoryEntry>(
      `SELECT 0 AS "revisionNo", received_at AS at, username AS by, NULL::text AS reason, NULL::jsonb AS changes
         FROM submissions WHERE id = $1::uuid
       UNION ALL
       SELECT revision_no, created_at, admin_username, reason, changes
         FROM submission_revisions WHERE submission_id = $1::uuid
       ORDER BY 1`,
      [submissionId],
    );
    return rows;
  }

  async newestFor(
    ids: readonly string[],
    username: string,
    q: Queryable = this.db,
  ): Promise<VersionRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await q.query<HeaderRow>(
      effectiveSql(`s.id = ANY($1::uuid[]) AND s.username = $2 AND r.id IS NOT NULL`),
      [ids, username],
    );
    return this.assemble(rows, q);
  }

  async correctionPhoto(
    submissionId: string,
    revisionNo: number,
    defectId: string,
    username: string,
    q: Queryable = this.db,
  ): Promise<VersionPhoto | null> {
    const { rows } = await q.query<PhotoRow>(
      `SELECT ${PHOTO_COLUMNS}
         FROM v_effective_photos p JOIN submissions s ON s.id = p.submission_id
        WHERE p.submission_id = $1::uuid AND p.revision_no = $2::integer AND p.revision_no > 0
          AND p.defect_id = $3 AND s.username = $4`,
      [submissionId, revisionNo, defectId, username],
    );
    return rows[0] ? toPhoto(rows[0]) : null;
  }

  async revisionPhoto(id: number, q: Queryable = this.db): Promise<VersionPhoto | null> {
    const { rows } = await q.query<PhotoRow>(
      `SELECT 'revision' AS source, id::text AS id, defect_id AS "defectId", object_key AS "objectKey",
              encode(sha256, 'hex') AS sha256, size_bytes AS "sizeBytes", '' AS key
         FROM submission_revision_photos WHERE id = $1::bigint`,
      [id],
    );
    return rows[0] ? toPhoto(rows[0]) : null;
  }

  /** Adds the findings and photos of each header's version. */
  private async assemble(headers: HeaderRow[], q: Queryable): Promise<VersionRecord[]> {
    if (headers.length === 0) return [];
    // A version is identified by its revision id, or by the submission id for an original.
    const keys = headers.map((h) => h.revisionId ?? h.submissionId);
    const originals = headers.filter((h) => !h.revisionId).map((h) => h.submissionId);
    const revisions = headers.filter((h) => h.revisionId).map((h) => h.revisionId!);
    const findings = await q.query<FindingRow>(
      `SELECT f.submission_id::text AS key, ${FINDING_COLUMNS}
         FROM submission_findings f ${FINDING_JOINS} WHERE f.submission_id = ANY($1::uuid[])
       UNION ALL
       SELECT f.revision_id::text, ${FINDING_COLUMNS}
         FROM submission_revision_findings f ${FINDING_JOINS} WHERE f.revision_id = ANY($2::uuid[])
       ORDER BY 1, "firstRecordedAt", "defectId"`,
      [originals, revisions],
    );
    const photos = await q.query<PhotoRow>(
      `SELECT p.submission_id::text AS key, 'original' AS source, p.id::text AS id, p.defect_id AS "defectId",
              p.object_key AS "objectKey", encode(p.sha256, 'hex') AS sha256, p.size_bytes AS "sizeBytes"
         FROM submission_photos p WHERE p.submission_id = ANY($1::uuid[])
       UNION ALL
       SELECT p.revision_id::text, 'revision', p.id::text, p.defect_id, p.object_key, encode(p.sha256, 'hex'),
              p.size_bytes
         FROM submission_revision_photos p WHERE p.revision_id = ANY($2::uuid[])
       ORDER BY 1, "defectId"`,
      [originals, revisions],
    );
    return headers.map((h, i) => {
      const key = keys[i]!;
      const versionFindings = findings.rows
        .filter((f) => f.key === key)
        .map((f): VersionFinding => ({
          inspectionType: f.inspectionType,
          areaId: f.areaId,
          subAreaId: f.subAreaId,
          familyId: f.familyId,
          defectId: f.defectId,
          defectName: f.defectName,
          severity: f.severity,
          areaName: f.areaName,
          subAreaName: f.subAreaName,
          familyName: f.familyName,
          qty: f.qty,
          firstRecordedAt: toWibIso(f.firstRecordedAt as unknown as Date),
        }));
      const versionPhotos = photos.rows.filter((p) => p.key === key).map(toPhoto);
      return toRecord(h, versionFindings, versionPhotos);
    });
  }
}

const FINDING_COLUMNS = `f.inspection_type AS "inspectionType", f.area_id AS "areaId",
  f.sub_area_id AS "subAreaId", f.family_id AS "familyId", f.defect_id AS "defectId",
  f.defect_name AS "defectName", f.severity, f.qty, f.first_recorded_at AS "firstRecordedAt",
  a.name AS "areaName", sa.name AS "subAreaName", fam.name AS "familyName"`;

const FINDING_JOINS = `JOIN areas a ON a.id = f.area_id JOIN sub_areas sa ON sa.id = f.sub_area_id
  JOIN families fam ON fam.id = f.family_id`;

const PHOTO_COLUMNS = `p.source, p.photo_id::text AS id, p.defect_id AS "defectId", p.object_key AS "objectKey",
  encode(p.sha256, 'hex') AS sha256, p.size_bytes AS "sizeBytes", '' AS key`;

function toPhoto(p: PhotoRow): VersionPhoto {
  return {
    source: p.source,
    id: Number(p.id),
    defectId: p.defectId,
    objectKey: p.objectKey,
    sha256: p.sha256,
    sizeBytes: p.sizeBytes,
  };
}

function toRecord(h: HeaderRow, findings: VersionFinding[], photos: VersionPhoto[]): VersionRecord {
  const counts: VersionCounts =
    h.qtyNoDefect !== null
      ? {
          rework: h.qtyRework,
          bGrade: h.qtyBGradeInspections,
          reworkApproved: h.qtyReworkApproved,
          noDefect: h.qtyNoDefect,
        }
      : {
          rework: h.qtyRework,
          bGrade: h.qtyBGradeInspections,
          reworkApproved: h.qtyReworkApproved,
          qtyInspection: h.qtyInspection,
        };
  return {
    submissionId: h.submissionId,
    displayNo: Number(h.displayNo),
    level: h.level,
    countingRule: h.countingRule,
    photoRule: h.photoRule,
    originalUsername: h.originalUsername,
    receivedAt: h.receivedAt,
    appVersion: h.appVersion,
    revisionNo: h.revisionNo,
    latestRevisionNo: h.latestRevisionNo,
    correctedAt: h.correctedAt,
    correctedBy: h.correctedBy,
    correctionReason: h.correctionReason,
    version: {
      sealedAt: toWibIso(h.sealedAt),
      username: h.username,
      factory: h.factory,
      cell: h.cell,
      po: h.po,
      article: h.article,
      model: h.model,
      destination: h.destination,
      orderQty: h.orderQty,
      podd: h.podd,
      crd: h.crd,
      partial:
        h.partialNo !== null && h.partialQty !== null
          ? { number: h.partialNo, qty: h.partialQty }
          : null,
      counts,
      findings,
      photos: photos.map((p) => ({ defectId: p.defectId, sha256: p.sha256 })),
    },
    totals: {
      qtyInspection: h.qtyInspection,
      qtyAGrade: h.qtyAGrade,
      qtyBGrade: h.qtyBGrade,
      qtyDefect: h.qtyDefect,
      rft: Number(h.rft),
      defectRate: Number(h.defectRate),
    },
    photos,
  };
}

/** doc 02 §6.3 for a revision: Qty Defect, Qty B-Grade and the photo count agree with its rows. */
async function recheck(tx: Queryable, revisionId: string): Promise<void> {
  const { rows } = await tx.query<Record<string, number>>(
    `SELECT r.qty_defect AS "qtyDefect", r.qty_b_grade AS "qtyBGrade", r.photo_count AS "photoCount",
            coalesce((SELECT sum(qty) FROM submission_revision_findings WHERE revision_id = r.id), 0)::integer
              AS "findingsQtyDefect",
            coalesce((SELECT sum(qty) FROM submission_revision_findings
                       WHERE revision_id = r.id AND inspection_type = 'B-GRADE'), 0)::integer AS "findingsQtyBGrade",
            (SELECT count(*) FROM submission_revision_photos WHERE revision_id = r.id)::integer AS "photoRows"
       FROM submission_revisions r WHERE r.id = $1::uuid`,
    [revisionId],
  );
  const r = rows[0]!;
  if (
    r.qtyDefect !== r.findingsQtyDefect ||
    r.qtyBGrade !== r.findingsQtyBGrade ||
    r.photoCount !== r.photoRows
  ) {
    throw new RevisionTotalsMismatch(revisionId, r);
  }
}
