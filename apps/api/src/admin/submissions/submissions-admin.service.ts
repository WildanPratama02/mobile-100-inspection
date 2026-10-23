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
  type DefectId,
  type Finding,
  formatDisplayNo,
  type InspectionType,
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

export interface AdminSubmissionSummary {
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
  counts: { rework: number; bGrade: number; noDefect: number };
  findings: AdminFinding[];
  top5: AdminTop5Place[];
  photos: { id: number; defectId: string }[];
  audit: { id: string; at: string; actor: string; action: string; details: unknown }[];
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

  async detail(id: string): Promise<AdminSubmissionDetail> {
    if (!isUuid(id)) throw new ApiProblem('NOT_FOUND', { detail: NOT_FOUND_DETAIL });
    const found = await this.db.run(async () => {
      const row = await this.repo.findById(id);
      if (!row) return null;
      const [findings, photos, audit] = await Promise.all([
        this.repo.findings([id]),
        this.repo.photos([id]),
        this.auditLog.search({ entity: 'submissions', entityId: id }, { offset: 0, limit: 100 }),
      ]);
      return { row, findings, photos, audit: audit.items };
    });
    if (!found) throw new ApiProblem('NOT_FOUND', { detail: NOT_FOUND_DETAIL });
    const { row, findings, photos, audit } = found;
    const photoOf = new Map(photos.map((p) => [p.defectId, p.id]));
    return {
      ...summaryOf(row),
      receivedAt: toWibIso(row.receivedAt),
      appVersion: row.appVersion,
      article: row.article,
      model: row.model,
      destination: row.destination,
      orderQty: row.orderQty,
      podd: row.podd,
      crd: row.crd,
      partial:
        row.partialNo !== null && row.partialQty !== null
          ? { number: row.partialNo, qty: row.partialQty }
          : null,
      counts: {
        rework: row.qtyRework,
        bGrade: row.qtyBGradeInspections,
        noDefect: row.qtyNoDefect,
      },
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
        firstRecordedAt: toWibIso(f.firstRecordedAt),
      })),
      top5: top5Of(findings).map((place, i) => ({
        rank: i + 1,
        defectId: place.defectId,
        defectName: place.defectName,
        classification: place.classification,
        qty: place.qty,
        photoId: photoOf.get(place.defectId) ?? null,
      })),
      photos: photos.map((p) => ({ id: p.id, defectId: p.defectId })),
      audit: audit.map((a) => ({
        id: a.id,
        at: toWibIso(a.at),
        actor: a.actor,
        action: a.action,
        details: a.details,
      })),
    };
  }

  /**
   * The JPEG of photo `id`, exactly as stored. A missing object (a row must never point to one, doc 02 §6.1) is
   * logged and answered `404`; a store error flips the `PHOTO_STORE` check and answers `503`.
   */
  async photo(id: string): Promise<Readable> {
    const n = /^[1-9][0-9]{0,15}$/.test(id) ? Number(id) : NaN;
    if (!Number.isSafeInteger(n)) {
      throw new ApiProblem('NOT_FOUND', { detail: PHOTO_NOT_FOUND_DETAIL });
    }
    const row = await this.db.run(() => this.repo.photo(n));
    if (!row) throw new ApiProblem('NOT_FOUND', { detail: PHOTO_NOT_FOUND_DETAIL });
    try {
      const stream = await this.photos.get(row.objectKey);
      // A read that fails at once (a disk error) must still become a problem answer, not a broken body.
      await once(stream, 'readable');
      return stream;
    } catch (error) {
      if (error instanceof PhotoNotFound) {
        this.logger.error(`Photo ${row.id} has a row but no object (${row.objectKey})`);
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
        bySubmission.set(f.submissionId, [...(bySubmission.get(f.submissionId) ?? []), f]);
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

/** `m100-submissions-2026-10-01-2026-10-31.csv`; an open end is `all`. */
export function exportFilename(filter: SubmissionFilter): string {
  return `m100-submissions-${filter.from ?? 'all'}-${filter.to ?? 'all'}.csv`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string) => UUID.test(s);
