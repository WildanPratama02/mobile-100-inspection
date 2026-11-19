/**
 * The admin's DataTable of submissions (doc 04 §8, doc 05 §20.3, FR-14.5): the filtered list, one submission with
 * its findings, Top 5 and photos, a photo, and the CSV export. Read only (AC-14.4): no method here changes a
 * submission, and the database refuses it anyway (BR-07). Reads write no `audit_log` row: the log records changes.
 */
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type AreaId,
  type Classification,
  type CountingRule,
  type DefectId,
  type Finding,
  formatDisplayNo,
  inspectionDate,
  partialText,
  type InspectionType,
  type PhotoRule,
  type PsiLevel,
  rankDefects,
  toWibIso,
} from '@m100/shared';
import { z } from 'zod';
import { ApiProblem } from '../../errors/problem';
import { RETRY_MS, ReadinessService } from '../../master-data/readiness.service';
import { PHOTO_STORE, type PhotoStore, PhotoNotFound } from '../../photos/photo-store';
import {
  AUDIT_LOG_REPOSITORY,
  type AuditLogRepository,
} from '../../repositories/audit-log.repository';
import {
  type ExportCursor,
  SUBMISSION_ADMIN_REPOSITORY,
  type SubmissionAdminRepository,
  type SubmissionFilter,
  type SubmissionFindingRow,
  type SubmissionRow,
} from '../../repositories/submission-admin.repository';
import {
  SUBMISSION_REVISION_REPOSITORY,
  type SubmissionRevisionRepository,
  type VersionPhoto,
  type VersionRecord,
} from '../../repositories/submission-revision.repository';
import { AdminDb } from '../admin-db';
import {
  isoDate,
  optionalQuery,
  pageQuery,
  parse,
  RANGE_ERROR,
  rangeInOrder,
} from '../admin-input';
import { csvHeader, csvLine, exportCells, type Top5Cell } from './csv';

/** Doc 05 §20.3: 50 per page. */
export const SUBMISSIONS_PAGE_SIZE = 50;
/** Rows the export reads per query. */
export const EXPORT_BATCH = 1_000;

const NOT_FOUND_DETAIL = 'Submission tidak ditemukan.';
const PHOTO_NOT_FOUND_DETAIL = 'Foto tidak ditemukan.';

const filterFields = {
  from: optionalQuery(isoDate),
  to: optionalQuery(isoDate),
  factory: optionalQuery(z.string().max(100)),
  cell: optionalQuery(z.string().max(100)),
  username: optionalQuery(z.string().max(100)),
  po: optionalQuery(z.string().max(100)),
};
const filterSchema = z.object(filterFields).refine(rangeInOrder, RANGE_ERROR);
const listSchema = z.object({ ...filterFields, page: pageQuery }).refine(rangeInOrder, RANGE_ERROR);
/** `?revision=<n>` of the detail (ADR-024, doc 04 §8.1). */
const detailSchema = z.object({
  revision: optionalQuery(
    z
      .string()
      .regex(/^(0|[1-9][0-9]{0,8})$/, 'revision harus bilangan bulat 0 atau lebih.')
      .transform(Number),
  ),
});

export interface AdminSubmissionSummary {
  countingRule: CountingRule;
  id: string;
  displayNo: string;
  sealedAt: string;
  inspectionDate: string;
  username: string;
  level: PsiLevel;
  factory: string;
  cell: string;
  po: string;
  partialText: string | null;
  qtyInspection: number;
  qtyDefect: number;
  qtyAGrade: number;
  qtyBGrade: number;
  rft: number;
  defectRate: number;
  photoCount: number;
  /** The revision shown (ADR-024); 0 for the PSI's submission. */
  revisionNo: number;
}

export interface AdminSubmissionPage {
  total: number;
  page: number;
  pageSize: number;
  items: AdminSubmissionSummary[];
}

export interface AdminFinding {
  inspectionType: InspectionType;
  areaId: string;
  areaName: string;
  subAreaId: string;
  subAreaName: string;
  familyId: string;
  familyName: string;
  defectId: string;
  defectName: string;
  classification: Classification;
  qty: number;
  firstRecordedAt: string;
}

export interface AdminTop5Place {
  rank: number;
  defectId: string;
  defectName: string;
  classification: Classification;
  qty: number;
  /** The photo of this defect, `null` when it has none (PSI lv.1). */
  photoId: number | null;
  /** Where to load it: `/v1/admin/photos/{id}` or, for a correction, `/v1/admin/revision-photos/{id}`. */
  photoUrl: string | null;
}

export interface AdminSubmissionDetail extends AdminSubmissionSummary {
  receivedAt: string;
  appVersion: string | null;
  article: string;
  model: string;
  destination: string;
  orderQty: number;
  podd: string | null;
  crd: string | null;
  partial: { number: number; qty: number } | null;
  /** `reworkApproved` is `null` for rows sealed before ADR-022; the admin app shows "–". */
  counts: {
    rework: number;
    bGrade: number;
    noDefect: number | null;
    qtyInspection: number;
    reworkApproved: number | null;
  };
  /** Stored `photo_rule`: `null` for PSI lv.1 and PSI lv.2 rows sealed before ADR-022 (Top 5 rule). */
  photoRule: PhotoRule | null;
  findings: AdminFinding[];
  top5: AdminTop5Place[];
  photos: { id: number; defectId: string; url: string }[];
  audit: { id: string; at: string; actor: string; action: string; details: unknown }[];
  /** The newest revision; the correction form sends it as `baseRevisionNo` (ADR-024). */
  latestRevisionNo: number;
  correctedAt: string | null;
  correctedBy: string | null;
  correctionReason: string | null;
}

interface CsvBatch {
  lines: string[];
  next: ExportCursor | null;
}

export interface CsvExport {
  filename: string;
  /** The BOM, the header and the rows, read batch by batch while the answer is sent. */
  chunks: AsyncIterable<string>;
}

@Injectable()
export class SubmissionsAdminService {
  private readonly logger = new Logger(SubmissionsAdminService.name);

  constructor(
    @Inject(SUBMISSION_ADMIN_REPOSITORY) private readonly repo: SubmissionAdminRepository,
    @Inject(AUDIT_LOG_REPOSITORY) private readonly auditLog: AuditLogRepository,
    @Inject(PHOTO_STORE) private readonly photos: PhotoStore,
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
    @Inject(AdminDb) private readonly db: AdminDb,
    @Inject(SUBMISSION_REVISION_REPOSITORY)
    private readonly revisions: SubmissionRevisionRepository,
  ) {}

  async list(query: unknown): Promise<AdminSubmissionPage> {
    const { page, ...filter } = parse(listSchema, query);
    const [total, rows] = await this.db.run(() =>
      Promise.all([
        this.repo.count(filter),
        this.repo.list(filter, {
          offset: (page - 1) * SUBMISSIONS_PAGE_SIZE,
          limit: SUBMISSIONS_PAGE_SIZE,
        }),
      ]),
    );
    return { total, page, pageSize: SUBMISSIONS_PAGE_SIZE, items: rows.map(summaryOf) };
  }

  /**
   * One submission: its effective version (ADR-024), or version `revision` (0 = the PSI's submission) when the
   * query names one; `404` for an unknown submission or revision.
   */
  async detail(id: string, query: unknown = {}): Promise<AdminSubmissionDetail> {
    if (!isUuid(id)) throw new ApiProblem('NOT_FOUND', { detail: NOT_FOUND_DETAIL });
    const { revision } = parse(detailSchema, query);
    const found = await this.db.run(async () => {
      const record = await this.revisions.findVersion(id, revision);
      if (!record) return null;
      const audit = await this.auditLog.search(
        { entity: 'submissions', entityId: id },
        { offset: 0, limit: 100 },
      );
      return { record, audit: audit.items };
    });
    if (!found) throw new ApiProblem('NOT_FOUND', { detail: NOT_FOUND_DETAIL });
    return detailOf(found.record, found.audit);
  }

  /**
   * The JPEG of photo `id` of the original (`submission_photos`), exactly as stored. A missing object (a row must
   * never point to one, doc 02 §6.1) is logged and answered `404`; a store error flips the `PHOTO_STORE` check and
   * answers `503`.
   */
  async photo(id: string): Promise<Readable> {
    const n = photoIdOf(id);
    const row = await this.db.run(() => this.repo.photo(n));
    if (!row) throw new ApiProblem('NOT_FOUND', { detail: PHOTO_NOT_FOUND_DETAIL });
    return this.stream(row.id, row.objectKey);
  }

  /** The JPEG of a correction's photo (`submission_revision_photos`, ADR-024), like `photo`. */
  async revisionPhoto(id: string): Promise<Readable> {
    const n = photoIdOf(id);
    const row = await this.db.run(() => this.revisions.revisionPhoto(n));
    if (!row) throw new ApiProblem('NOT_FOUND', { detail: PHOTO_NOT_FOUND_DETAIL });
    return this.stream(row.id, row.objectKey);
  }

  private async stream(id: number, objectKey: string): Promise<Readable> {
    try {
      const stream = await this.photos.get(objectKey);
      // A read that fails at once (a disk error) must still become a problem answer, not a broken body.
      await once(stream, 'readable');
      return stream;
    } catch (error) {
      if (error instanceof PhotoNotFound) {
        this.logger.error(`Photo ${id} has a row but no object (${objectKey})`);
        throw new ApiProblem('NOT_FOUND', { detail: PHOTO_NOT_FOUND_DETAIL });
      }
      this.readiness.reportFailure('PHOTO_STORE', error);
      throw new ApiProblem('PHOTO_STORE_UNAVAILABLE', { retryAfter: RETRY_MS / 1000 });
    }
  }

  /**
   * The CSV of every submission the filter selects, in the list's order (doc 04 §10 A14). The first batch is read
   * before anything is sent, so a bad filter or a database that is down still gets a proper problem answer.
   */
  async exportCsv(query: unknown): Promise<CsvExport> {
    const filter = parse(filterSchema, query);
    const first = await this.batch(filter, null);
    return { filename: exportFilename(filter), chunks: this.chunks(filter, first) };
  }

  private async *chunks(filter: SubmissionFilter, first: CsvBatch): AsyncGenerator<string> {
    yield csvHeader();
    let batch = first;
    for (;;) {
      if (batch.lines.length) yield batch.lines.join('');
      if (batch.lines.length < EXPORT_BATCH || !batch.next) return;
      batch = await this.batch(filter, batch.next);
    }
  }

  /** One batch of CSV lines after `cursor`, and the cursor of its last row. */
  private async batch(filter: SubmissionFilter, cursor: ExportCursor | null): Promise<CsvBatch> {
    return this.db.run(async () => {
      const rows = await this.repo.exportBatch(filter, cursor, EXPORT_BATCH);
      const findings = await this.repo.findings(rows.map((r) => r.id));
      const bySubmission = new Map<string, SubmissionFindingRow[]>();
      for (const f of findings) {
        const list = bySubmission.get(f.submissionId);
        if (list) list.push(f);
        else bySubmission.set(f.submissionId, [f]);
      }
      return {
        lines: rows.map((row) => csvLine(exportCells(row, top5Of(bySubmission.get(row.id) ?? [])))),
        next: rows.at(-1)?.cursor ?? null,
      };
    });
  }
}

function summaryOf(row: SubmissionRow): AdminSubmissionSummary {
  return {
    countingRule: row.countingRule,
    id: row.id,
    displayNo: formatDisplayNo(row.displayNo),
    sealedAt: toWibIso(row.sealedAt),
    inspectionDate: row.inspectionDate,
    username: row.username,
    level: row.level,
    factory: row.factory,
    cell: row.cell,
    po: row.po,
    partialText: row.partialText,
    qtyInspection: row.qtyInspection,
    qtyDefect: row.qtyDefect,
    qtyAGrade: row.qtyAGrade,
    qtyBGrade: row.qtyBGrade,
    rft: Number(row.rft),
    defectRate: Number(row.defectRate),
    photoCount: row.photoCount,
    revisionNo: row.revisionNo,
  };
}

/**
 * The Top 5 of a submission's findings with the shared ranking (`rankDefects`, the tablet's order), using the
 * severity and name the submission stored.
 */
function top5Of(
  findings: readonly SubmissionFindingRow[],
): (Top5Cell & { classification: Classification })[] {
  const byDefect = new Map(findings.map((f) => [f.defectId, f]));
  const asFindings: Finding[] = findings.map((f) => ({
    inspectionType: f.inspectionType,
    areaId: f.areaId as AreaId,
    subAreaId: f.subAreaId,
    familyId: f.familyId,
    defectId: f.defectId,
    qty: f.qty,
    firstRecordedAt: f.firstRecordedAt.toISOString(),
  }));
  return rankDefects(asFindings, (id: DefectId) => byDefect.get(id)!.severity)
    .slice(0, 5)
    .map((d) => ({
      defectId: d.defectId,
      defectName: byDefect.get(d.defectId)!.defectName,
      classification: d.classification,
      qty: d.qty,
    }));
}

/** Where the admin app loads a photo of a version (ADR-024). */
export function photoUrl(photo: Pick<VersionPhoto, 'source' | 'id'>): string {
  return photo.source === 'revision'
    ? `/v1/admin/revision-photos/${photo.id}`
    : `/v1/admin/photos/${photo.id}`;
}

/** The detail of one version (doc 04 §10 A13, §8.1). */
function detailOf(
  record: VersionRecord,
  audit: readonly { id: string; at: Date; actor: string; action: string; details: unknown }[],
): AdminSubmissionDetail {
  const { version: v, totals } = record;
  const photoOf = new Map(record.photos.map((p) => [p.defectId, p]));
  const findings = v.findings;
  const byDefect = new Map(findings.map((f) => [f.defectId, f]));
  const ranked = rankDefects(findings, (id: DefectId) => byDefect.get(id)!.severity).slice(0, 5);
  return {
    countingRule: record.countingRule,
    id: record.submissionId,
    displayNo: formatDisplayNo(record.displayNo),
    sealedAt: v.sealedAt,
    inspectionDate: inspectionDate(v.sealedAt),
    username: v.username,
    level: record.level,
    factory: v.factory,
    cell: v.cell,
    po: v.po,
    partialText: v.partial ? partialText(v.partial, v.orderQty) : null,
    qtyInspection: totals.qtyInspection,
    qtyDefect: totals.qtyDefect,
    qtyAGrade: totals.qtyAGrade,
    qtyBGrade: totals.qtyBGrade,
    rft: totals.rft,
    defectRate: totals.defectRate,
    photoCount: record.photos.length,
    revisionNo: record.revisionNo,
    receivedAt: toWibIso(record.receivedAt),
    appVersion: record.appVersion,
    article: v.article,
    model: v.model,
    destination: v.destination,
    orderQty: v.orderQty,
    podd: v.podd,
    crd: v.crd,
    partial: v.partial,
    counts: {
      rework: v.counts.rework,
      bGrade: v.counts.bGrade,
      noDefect: v.counts.noDefect ?? null,
      qtyInspection: totals.qtyInspection,
      reworkApproved: v.counts.reworkApproved,
    },
    photoRule: record.photoRule,
    findings: findings.map((f) => ({
      inspectionType: f.inspectionType,
      areaId: f.areaId,
      areaName: f.areaName,
      subAreaId: f.subAreaId,
      subAreaName: f.subAreaName,
      familyId: f.familyId,
      familyName: f.familyName,
      defectId: f.defectId,
      defectName: f.defectName,
      classification: f.severity,
      qty: f.qty,
      firstRecordedAt: f.firstRecordedAt,
    })),
    top5: ranked.map((place, i) => {
      const photo = photoOf.get(place.defectId);
      return {
        rank: i + 1,
        defectId: place.defectId,
        defectName: byDefect.get(place.defectId)!.defectName,
        classification: place.classification,
        qty: place.qty,
        photoId: photo?.id ?? null,
        photoUrl: photo ? photoUrl(photo) : null,
      };
    }),
    photos: record.photos.map((p) => ({ id: p.id, defectId: p.defectId, url: photoUrl(p) })),
    audit: audit.map((a) => ({
      id: a.id,
      at: toWibIso(a.at),
      actor: a.actor,
      action: a.action,
      details: a.details,
    })),
    latestRevisionNo: record.latestRevisionNo,
    correctedAt: record.correctedAt ? toWibIso(record.correctedAt) : null,
    correctedBy: record.correctedBy,
    correctionReason: record.correctionReason,
  };
}

/** A photo id from the path; anything else is `404`. */
function photoIdOf(id: string): number {
  const n = /^[1-9][0-9]{0,15}$/.test(id) ? Number(id) : NaN;
  if (!Number.isSafeInteger(n)) {
    throw new ApiProblem('NOT_FOUND', { detail: PHOTO_NOT_FOUND_DETAIL });
  }
  return n;
}

/** `m100-submissions-2026-10-01-2026-10-31.csv`; an open end is `all`. */
export function exportFilename(filter: SubmissionFilter): string {
  return `m100-submissions-${filter.from ?? 'all'}-${filter.to ?? 'all'}.csv`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string) => UUID.test(s);
