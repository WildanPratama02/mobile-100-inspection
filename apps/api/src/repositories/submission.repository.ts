/**
 * Submissions (doc 02 §4, §6). Written once, in one transaction (doc 02 §6.1 step 4), and never updated or deleted
 * (BR-07; the trigger and the grants enforce it). The caller validates, computes the totals (doc 04 §4.1) and puts
 * the photos into the store before calling `write` (T3.3).
 */
import { countingRule } from '@m100/shared';
import type {
  DefectId,
  Finding,
  PoPartial,
  PsiLevel,
  SubmissionCounts,
  Totals,
} from '@m100/shared';
import type { Database, Queryable } from '../db/database';

export const SUBMISSION_REPOSITORY = Symbol('SubmissionRepository');

export interface StoredPhoto {
  defectId: DefectId;
  /** `submissions/<yyyy>/<MM>/<uuid>/<defectId>.jpg` (doc 02 §7). */
  objectKey: string;
  /** 32 bytes. */
  sha256: Buffer;
  sizeBytes: number;
}

export interface NewSubmission {
  /** The tablet's submission UUID, the idempotency key (BR-06). */
  id: string;
  /** SHA-256 of the JSON part as received (doc 04 §4.3). */
  payloadSha256: Buffer;
  /** ISO 8601. */
  sealedAt: string;
  /** WIB date of `sealedAt`, `YYYY-MM-DD` (doc 02 §6.4). */
  inspectionDate: string;
  appVersion: string | null;
  deviceId: string | null;
  username: string;
  level: PsiLevel;
  factory: string;
  cell: string;
  /** Article, model, destination, order quantity and dates are copied from `pos` inside the transaction. */
  po: string;
  partial: PoPartial | null;
  counts: SubmissionCounts;
  /** From `computeTotals`; Qty Inspection ≥ 1, so both rates are numbers. */
  totals: Totals;
  /** Defect name and severity are copied from `defects` inside the transaction. */
  findings: readonly Finding[];
  photos: readonly StoredPhoto[];
}

/** What a repeated request needs to answer `200` exactly like the original `201` (doc 04 §4.4). */
export interface StoredSubmission {
  id: string;
  payloadSha256: Buffer;
  displayNo: number;
  receivedAt: Date;
  totals: {
    qtyInspection: number;
    qtyAGrade: number;
    qtyBGrade: number;
    qtyDefect: number;
    /** Fractions with 5 decimals, as stored. */
    rft: number;
    defectRate: number;
  };
}

export interface WriteResult {
  /** `false` when a submission with this id already existed (an earlier or concurrent attempt won). */
  written: boolean;
  submission: StoredSubmission;
}

/** The in-transaction re-check found totals that disagree with the stored rows: a server bug (doc 03 §5.7). */
export class SubmissionTotalsMismatch extends Error {
  constructor(
    readonly submissionId: string,
    readonly detail: Record<string, number>,
  ) {
    super(
      `Submission ${submissionId}: stored totals disagree with its rows ${JSON.stringify(detail)}`,
    );
    this.name = 'SubmissionTotalsMismatch';
  }
}

export interface SubmissionRepository {
  findById(id: string, q?: Queryable): Promise<StoredSubmission | null>;
  /**
   * Inserts the submission with its findings and photo rows in one transaction, or returns the existing one.
   * Throws `SubmissionTotalsMismatch` (nothing written) when the re-check fails.
   */
  write(submission: NewSubmission): Promise<WriteResult>;
  /** Those of `keys` that a `submission_photos` row points to (the orphan sweep, doc 02 §6.2). */
  photoKeysInUse(keys: readonly string[], q?: Queryable): Promise<Set<string>>;
}

const STORED = `id, payload_sha256 AS "payloadSha256", display_no AS "displayNo", received_at AS "receivedAt",
                qty_inspection AS "qtyInspection", qty_a_grade AS "qtyAGrade", qty_b_grade AS "qtyBGrade",
                qty_defect AS "qtyDefect", rft, defect_rate AS "defectRate"`;

interface StoredRow {
  id: string;
  payloadSha256: Buffer;
  displayNo: string;
  receivedAt: Date;
  qtyInspection: number;
  qtyAGrade: number;
  qtyBGrade: number;
  qtyDefect: number;
  rft: string;
  defectRate: string;
}

function stored(row: StoredRow): StoredSubmission {
  return {
    id: row.id,
    payloadSha256: row.payloadSha256,
    displayNo: Number(row.displayNo),
    receivedAt: row.receivedAt,
    totals: {
      qtyInspection: row.qtyInspection,
      qtyAGrade: row.qtyAGrade,
      qtyBGrade: row.qtyBGrade,
      qtyDefect: row.qtyDefect,
      rft: Number(row.rft),
      defectRate: Number(row.defectRate),
    },
  };
}

export class PgSubmissionRepository implements SubmissionRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string, q: Queryable = this.db): Promise<StoredSubmission | null> {
    const { rows } = await q.query<StoredRow>(`SELECT ${STORED} FROM submissions WHERE id = $1`, [
      id,
    ]);
    return rows[0] ? stored(rows[0]) : null;
  }

  async photoKeysInUse(keys: readonly string[], q: Queryable = this.db): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const { rows } = await q.query<{ objectKey: string }>(
      'SELECT object_key AS "objectKey" FROM submission_photos WHERE object_key = ANY($1::text[])',
      [keys],
    );
    return new Set(rows.map((r) => r.objectKey));
  }

  async write(s: NewSubmission): Promise<WriteResult> {
    const { totals } = s;
    if (totals.passRate === null || totals.defectRate === null) {
      throw new Error(`Submission ${s.id}: Qty Inspection is 0, nothing to write (FR-11)`);
    }
    const { passRate, defectRate } = totals;

    return this.db.transaction(async (tx) => {
      // Explicit casts: parameters of INSERT … SELECT do not take the target columns' types.
      const inserted = await tx.query<StoredRow>(
        `INSERT INTO submissions (
           id, payload_sha256, sealed_at, inspection_date, app_version, device_id,
           username, level, factory, cell,
           po, article, model, destination, order_qty, podd, crd, partial_no, partial_qty,
           qty_rework, qty_bgrade_inspections, qty_no_defect,
           qty_inspection, qty_a_grade, qty_b_grade, qty_defect, rft, defect_rate, photo_count, counting_rule)
         SELECT $1::uuid, $2::bytea, $3::timestamptz, $4::date, $5::text, $6::uuid,
                $7::text, $8::text, $9::text, $10::text,
                p.po, p.article, p.model, p.destination, p.order_qty, p.podd, p.crd, $12::smallint, $13::integer,
                $14::integer, $15::integer, $16::integer,
                $17::integer, $18::integer, $19::integer, $20::integer, $21::numeric, $22::numeric, $23::smallint,
                $24::text
           FROM pos p WHERE p.po = $11
         ON CONFLICT (id) DO NOTHING
         RETURNING ${STORED}`,
        [
          s.id,
          s.payloadSha256,
          s.sealedAt,
          s.inspectionDate,
          s.appVersion,
          s.deviceId,
          s.username,
          s.level,
          s.factory,
          s.cell,
          s.po,
          s.partial?.number ?? null,
          s.partial?.qty ?? null,
          s.counts.rework,
          s.counts.bGrade,
          s.counts.noDefect ?? null,
          totals.qtyInspection,
          totals.qtyAGrade,
          totals.qtyBGrade,
          totals.qtyDefect,
          passRate,
          defectRate,
          s.photos.length,
          countingRule(s.counts),
        ],
      );
      const row = inserted.rows[0];
      if (!row) {
        // Either the id exists (answer as in doc 02 §6.1 step 1) or the PO does not.
        const existing = await this.findById(s.id, tx);
        if (existing) return { written: false, submission: existing };
        throw new Error(`Submission ${s.id}: PO ${s.po} is not in pos`);
      }

      await this.insertFindings(tx, s);
      await this.insertPhotos(tx, s);
      await recheck(tx, s.id);
      return { written: true, submission: stored(row) };
    });
  }

  private async insertFindings(tx: Queryable, s: NewSubmission): Promise<void> {
    if (s.findings.length === 0) return;
    const f = s.findings;
    const { rowCount } = await tx.query(
      `INSERT INTO submission_findings (submission_id, inspection_type, area_id, sub_area_id, family_id, defect_id,
                                        defect_name, severity, qty, first_recorded_at)
       SELECT $1::uuid, f.inspection_type, f.area_id, f.sub_area_id, f.family_id, f.defect_id,
              d.name, d.severity, f.qty, f.first_recorded_at
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::integer[], $8::timestamptz[])
              AS f (inspection_type, area_id, sub_area_id, family_id, defect_id, qty, first_recorded_at)
         JOIN defects d ON d.id = f.defect_id`,
      [
        s.id,
        f.map((x) => x.inspectionType),
        f.map((x) => x.areaId),
        f.map((x) => x.subAreaId),
        f.map((x) => x.familyId),
        f.map((x) => x.defectId),
        f.map((x) => x.qty),
        f.map((x) => x.firstRecordedAt),
      ],
    );
    // The join drops a finding whose defect does not exist; validation should have refused it.
    if (rowCount !== f.length) {
      throw new Error(
        `Submission ${s.id}: ${f.length - (rowCount ?? 0)} finding(s) name an unknown defect`,
      );
    }
  }

  private async insertPhotos(tx: Queryable, s: NewSubmission): Promise<void> {
    if (s.photos.length === 0) return;
    const p = s.photos;
    await tx.query(
      `INSERT INTO submission_photos (submission_id, defect_id, object_key, sha256, size_bytes)
       SELECT $1::uuid, * FROM unnest($2::text[], $3::text[], $4::bytea[], $5::integer[])`,
      [
        s.id,
        p.map((x) => x.defectId),
        p.map((x) => x.objectKey),
        p.map((x) => x.sha256),
        p.map((x) => x.sizeBytes),
      ],
    );
  }
}

/** doc 02 §6.3: Qty Defect, Qty B-Grade and the photo count agree with the rows just written. */
async function recheck(tx: Queryable, id: string): Promise<void> {
  const { rows } = await tx.query<Record<string, number>>(
    `SELECT s.qty_defect AS "qtyDefect", s.qty_b_grade AS "qtyBGrade", s.photo_count AS "photoCount",
            coalesce(f.qty_defect, 0)::integer AS "findingsQtyDefect",
            coalesce(f.qty_b_grade, 0)::integer AS "findingsQtyBGrade",
            (SELECT count(*) FROM submission_photos p WHERE p.submission_id = s.id)::integer AS "photoRows"
       FROM submissions s
       LEFT JOIN (SELECT submission_id, sum(qty) AS qty_defect,
                         sum(qty) FILTER (WHERE inspection_type = 'B-GRADE') AS qty_b_grade
                    FROM submission_findings WHERE submission_id = $1 GROUP BY submission_id) f
         ON f.submission_id = s.id
      WHERE s.id = $1`,
    [id],
  );
  const r = rows[0]!;
  if (
    r.qtyDefect !== r.findingsQtyDefect ||
    r.qtyBGrade !== r.findingsQtyBGrade ||
    r.photoCount !== r.photoRows
  ) {
    throw new SubmissionTotalsMismatch(id, r);
  }
}
