/**
 * The tablet's reads of admin corrections (ADR-023, doc 04 §3.4, doc 03 §4.11): the newest correction of the
 * token's own submissions, and the photos of that correction. Only submissions whose original PSI is the token's
 * `sub` are answered; any other id is simply left out, so the answer never tells whether another PSI's submission
 * exists. Nothing here writes.
 */
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type Classification,
  type CountingRule,
  type DefectId,
  formatDisplayNo,
  inspectionDate,
  type InspectionType,
  type PhotoRule,
  type PoPartial,
  type PsiLevel,
} from '@m100/shared';
import type { TabletClaims } from '../auth/tablet-token';
import { isDbUnavailable } from '../db/database';
import { ApiProblem } from '../errors/problem';
import { checksFailed } from '../errors/validation';
import { RETRY_MS, ReadinessService } from '../master-data/readiness.service';
import { PHOTO_STORE, type PhotoStore, PhotoNotFound } from '../photos/photo-store';
import {
  SUBMISSION_REVISION_REPOSITORY,
  type SubmissionRevisionRepository,
  type VersionRecord,
} from '../repositories/submission-revision.repository';

/** Submission ids per request (doc 04 §7). */
export const MAX_CORRECTION_IDS = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHOTO_NOT_FOUND_DETAIL = 'Foto tidak ditemukan.';

/** `Correction` of `04-openapi.yaml`. */
export interface Correction {
  submissionUuid: string;
  revisionNo: number;
  correctedAt: string;
  reason: string;
  submission: {
    displayNo: string;
    sealedAt: string;
    inspectionDate: string;
    user: { username: string; level: PsiLevel };
    factory: string;
    cell: string;
    po: string;
    article: string;
    model: string;
    destination: string;
    orderQty: number;
    partial: PoPartial | null;
    countingRule: CountingRule;
    photoRule: PhotoRule | null;
    counts: {
      rework: number;
      bGrade: number;
      reworkApproved: number;
      qtyInspection?: number;
      noDefect?: number;
    };
    findings: {
      inspectionType: InspectionType;
      areaId: string;
      subAreaId: string;
      familyId: string;
      defectId: DefectId;
      qty: number;
      firstRecordedAt: string;
      defectName: string;
      severity: Classification;
    }[];
    totals: {
      qtyInspection: number;
      qtyAGrade: number;
      qtyBGrade: number;
      qtyDefect: number;
      rft: number;
      defectRate: number;
    };
  };
  photos: { defectId: DefectId; sha256: string; sizeBytes: number }[];
}

@Injectable()
export class CorrectionsService {
  private readonly logger = new Logger('Corrections');

  constructor(
    @Inject(SUBMISSION_REVISION_REPOSITORY)
    private readonly revisions: SubmissionRevisionRepository,
    @Inject(PHOTO_STORE) private readonly photos: PhotoStore,
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
  ) {}

  /** `GET /submissions/corrections?ids=` */
  async newest(ids: unknown, claims: TabletClaims): Promise<{ items: Correction[] }> {
    const list = parseIds(ids);
    const records = await this.database(() => this.revisions.newestFor(list, claims.sub));
    return { items: records.map(correctionOf) };
  }

  /** `GET /submissions/{id}/corrections/{revisionNo}/photos/{defectId}` */
  async photo(
    id: string,
    revisionNo: string,
    defectId: string,
    claims: TabletClaims,
  ): Promise<Readable> {
    const n = /^[1-9][0-9]{0,8}$/.test(revisionNo) ? Number(revisionNo) : NaN;
    if (!UUID.test(id) || !Number.isSafeInteger(n) || !/^D\d{3}$/.test(defectId)) {
      throw new ApiProblem('NOT_FOUND', { detail: PHOTO_NOT_FOUND_DETAIL });
    }
    const row = await this.database(() =>
      this.revisions.correctionPhoto(id, n, defectId, claims.sub),
    );
    if (!row) throw new ApiProblem('NOT_FOUND', { detail: PHOTO_NOT_FOUND_DETAIL });
    try {
      const stream = await this.photos.get(row.objectKey);
      await once(stream, 'readable');
      return stream;
    } catch (error) {
      if (error instanceof PhotoNotFound) {
        this.logger.error(`Correction photo ${row.id} has a row but no object (${row.objectKey})`);
        throw new ApiProblem('NOT_FOUND', { detail: PHOTO_NOT_FOUND_DETAIL });
      }
      this.readiness.reportFailure('PHOTO_STORE', error);
      throw new ApiProblem('PHOTO_STORE_UNAVAILABLE', { retryAfter: RETRY_MS / 1000 });
    }
  }

  private async database<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ApiProblem || !isDbUnavailable(error)) throw error;
      this.readiness.reportFailure('DB', error);
      throw new ApiProblem('DB_UNAVAILABLE', { retryAfter: RETRY_MS / 1000 });
    }
  }
}

/** `ids`: 1–50 UUIDs separated by commas; anything else is `422`. */
function parseIds(ids: unknown): string[] {
  const text = typeof ids === 'string' ? ids : '';
  const list = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0 || list.length > MAX_CORRECTION_IDS || !list.every((s) => UUID.test(s))) {
    throw checksFailed([
      {
        path: 'ids',
        code: 'INVALID',
        message: `ids: 1 sampai ${MAX_CORRECTION_IDS} UUID, dipisah koma.`,
      },
    ]);
  }
  return [...new Set(list.map((s) => s.toLowerCase()))];
}

function correctionOf(record: VersionRecord): Correction {
  const { version: v, totals } = record;
  return {
    submissionUuid: record.submissionId,
    revisionNo: record.revisionNo,
    correctedAt: record.correctedAt!.toISOString(),
    reason: record.correctionReason!,
    submission: {
      displayNo: formatDisplayNo(record.displayNo),
      sealedAt: v.sealedAt,
      inspectionDate: inspectionDate(v.sealedAt),
      user: { username: v.username, level: record.level },
      factory: v.factory,
      cell: v.cell,
      po: v.po,
      article: v.article,
      model: v.model,
      destination: v.destination,
      orderQty: v.orderQty,
      partial: v.partial,
      countingRule: record.countingRule,
      photoRule: record.photoRule,
      counts: {
        rework: v.counts.rework,
        bGrade: v.counts.bGrade,
        reworkApproved: v.counts.reworkApproved ?? 0,
        ...(v.counts.noDefect !== undefined
          ? { noDefect: v.counts.noDefect }
          : { qtyInspection: v.counts.qtyInspection }),
      },
      findings: v.findings.map((f) => ({
        inspectionType: f.inspectionType,
        areaId: f.areaId,
        subAreaId: f.subAreaId,
        familyId: f.familyId,
        defectId: f.defectId,
        qty: f.qty,
        firstRecordedAt: f.firstRecordedAt,
        defectName: f.defectName,
        severity: f.severity,
      })),
      totals,
    },
    photos: record.photos.map((p) => ({
      defectId: p.defectId,
      sha256: p.sha256,
      sizeBytes: p.sizeBytes,
    })),
  };
}
