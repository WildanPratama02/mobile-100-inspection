/**
 * Admin corrections of a submission (ADR-023, PRD FR-17, doc 02 §6.5, doc 04 §8.1). A correction is a complete new
 * version, written as a revision; the original rows never change (BR-07). The order follows a Submit PO: read the
 * multipart body, answer a repeat from what is stored, validate at `REPEATABLE READ` with the shared rules of
 * `@m100/shared` for the original's counting and photo rule, put the new photos into the store, then one transaction
 * (lock, re-check of the base revision, the rows, the sums, the audit row). The answer is synchronous.
 */
import type { IncomingMessage } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import {
  checkRevision,
  type DefectId,
  type Po,
  photoKey,
  type RevisionFinding,
  type RevisionOriginal,
  type RevisionRequest,
  revisionChanges,
  revisionVersion,
  versionTotals,
} from '@m100/shared';
import { z } from 'zod';
import type { AdminPrincipal } from '../../auth/auth.decorator';
import {
  Database,
  isDbUnavailable,
  isRetryableTransactionError,
  type Queryable,
} from '../../db/database';
import { ApiProblem } from '../../errors/problem';
import { checksFailed, type Failure, validationFailed } from '../../errors/validation';
import { RETRY_MS, ReadinessService } from '../../master-data/readiness.service';
import { PHOTO_STORE, type PhotoStore } from '../../photos/photo-store';
import {
  AUDIT_LOG_REPOSITORY,
  type AuditLogRepository,
} from '../../repositories/audit-log.repository';
import {
  MASTER_DATA_REPOSITORY,
  type MasterDataRepository,
} from '../../repositories/master-data.repository';
import { PO_REPOSITORY, type PoRepository } from '../../repositories/po.repository';
import {
  type HistoryEntry,
  type NewRevisionPhoto,
  SUBMISSION_REVISION_REPOSITORY,
  type SubmissionRevisionRepository,
  type VersionRecord,
} from '../../repositories/submission-revision.repository';
import { MULTIPART_LIMITS, readSubmissionParts, sha256Hex } from '../../submissions/multipart';
import { MAX_FINDINGS } from '../../submissions/submission-schema';
import { KeyedLock } from '../../submissions/submission.service';
import { mapRowOf } from '../../submissions/submission-validator';
import { type AdminSubmissionDetail, SubmissionsAdminService } from './submissions-admin.service';

/** The JSON part of a correction (doc 04 §8.1). */
export const REVISION_PART = 'revision';

const NOT_FOUND_DETAIL = 'Submission tidak ditemukan.';
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const moment = z.iso.datetime({ offset: true });
const defectId = z
  .string()
  .regex(/^D\d{3}$/)
  .transform((id) => id as DefectId);
const count = z.int().min(0);

/** `RevisionRequest` of `04-openapi.yaml`; unknown fields are refused. */
const revisionSchema = z.strictObject({
  revisionId: z.uuidv4(),
  baseRevisionNo: z.int().min(0),
  reason: z.string().max(2000),
  sealedAt: moment,
  username: z.string().min(1),
  factory: z.string().min(1),
  cell: z.string().min(1),
  po: z.string().min(1),
  partial: z.strictObject({ number: z.int().min(1).max(99), qty: z.int().min(1) }).nullable(),
  counts: z.strictObject({
    rework: count,
    bGrade: count,
    reworkApproved: z.int('REWORK AND APPROVED harus bilangan bulat 0 atau lebih.').min(0),
    qtyInspection: z
      .int('Qty Inspection minimal 1.')
      .min(1, 'Qty Inspection minimal 1.')
      .optional(),
    noDefect: count.optional(),
  }),
  findings: z
    .array(
      z.strictObject({
        inspectionType: z.enum(['REWORK', 'B-GRADE']),
        areaId: z
          .string()
          .regex(/^A\d{2}$/)
          .transform((id) => id as `A${string}`),
        subAreaId: z.string().min(1),
        familyId: z.string().min(1).optional(),
        defectId,
        qty: z.int().min(1),
        // Set by the API (doc 02 §4.4); accepted and ignored so the form may send findings as it read them.
        firstRecordedAt: moment.optional(),
      }),
    )
    .max(MAX_FINDINGS),
  photos: z
    .array(
      z.union([
        z.strictObject({ defectId, keep: z.literal(true) }),
        z.strictObject({
          defectId,
          part: z.string().min(1),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      ]),
    )
    .max(98),
});

export interface RevisionOutcome {
  status: 200 | 201;
  body: AdminSubmissionDetail;
}

export interface AdminRevisionHistory {
  items: {
    revisionNo: number;
    at: string;
    by: string;
    reason: string | null;
    changes: unknown;
  }[];
}

/** A correction that passed every check, ready for the write. */
interface ValidRevision {
  request: RevisionRequest;
  base: VersionRecord;
  /** The PO master row when the PO number changed. */
  poMaster: Po | null;
  /** New photo parts by defect. */
  newPhotos: Map<string, Buffer>;
}

@Injectable()
export class RevisionsAdminService {
  private readonly locks = new KeyedLock();

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(SUBMISSION_REVISION_REPOSITORY)
    private readonly revisions: SubmissionRevisionRepository,
    @Inject(MASTER_DATA_REPOSITORY) private readonly masterData: MasterDataRepository,
    @Inject(PO_REPOSITORY) private readonly pos: PoRepository,
    @Inject(AUDIT_LOG_REPOSITORY) private readonly auditLog: AuditLogRepository,
    @Inject(PHOTO_STORE) private readonly photos: PhotoStore,
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
    @Inject(SubmissionsAdminService) private readonly submissions: SubmissionsAdminService,
  ) {}

  /** `GET /admin/submissions/{id}/revisions`: revision 0 and every correction, oldest first. */
  async history(id: string): Promise<AdminRevisionHistory> {
    if (!UUID.test(id)) throw new ApiProblem('NOT_FOUND', { detail: NOT_FOUND_DETAIL });
    const entries = await this.database(() => this.revisions.history(id));
    if (entries.length === 0) throw new ApiProblem('NOT_FOUND', { detail: NOT_FOUND_DETAIL });
    return { items: entries.map(historyItem) };
  }

  /** `POST /admin/submissions/{id}/revisions` (doc 04 §8.1). */
  async create(id: string, req: IncomingMessage, admin: AdminPrincipal): Promise<RevisionOutcome> {
    const parts = await readSubmissionParts(req, MULTIPART_LIMITS, REVISION_PART);
    if (!UUID.test(id)) throw new ApiProblem('NOT_FOUND', { detail: NOT_FOUND_DETAIL });
    const parsed = revisionSchema.safeParse(parts.body);
    if (!parsed.success) throw validationFailed(parsed.error, parts.body);
    const request = parsed.data as RevisionRequest;
    // One correction of a submission at a time in this process; the advisory lock covers other processes.
    return this.locks.run(id, async () => {
      const repeat = await this.repeat(id, request.revisionId, parts.payloadSha256);
      if (repeat) return repeat;
      const valid = await this.validate(id, request, parts.photos);
      return this.write(id, valid, parts.payloadSha256, admin);
    });
  }

  /** Step 1: a revision id already stored is answered from what is stored, or refused when its bytes differ. */
  private async repeat(
    id: string,
    revisionId: string,
    sha256: string,
  ): Promise<RevisionOutcome | null> {
    const stored = await this.database(() => this.revisions.findRevision(revisionId));
    if (!stored) return null;
    if (stored.submissionId !== id || stored.requestSha256 !== sha256) {
      throw new ApiProblem('CONFLICT', {
        detail: 'Koreksi ini sudah tersimpan dengan isi lain.',
      });
    }
    return { status: 200, body: await this.submissions.detail(id) };
  }

  /** Step 2 (doc 02 §6.5): the base, the master data and the shared rules, in one read-only snapshot. */
  private async validate(
    id: string,
    request: RevisionRequest,
    parts: Map<string, Buffer>,
  ): Promise<ValidRevision> {
    const now = new Date();
    const result = await this.database(() =>
      this.db.transaction((q) => this.checkMaster(id, request, q), {
        isolation: 'REPEATABLE READ',
        readOnly: true,
      }),
    );
    const { base, failures, poMaster, userLevel, orderQty, defects } = result;
    const original: RevisionOriginal = {
      level: base.level,
      countingRule: base.countingRule,
      photoRule: base.photoRule,
    };
    const resolved: RevisionRequest = { ...request, findings: result.findings };
    failures.push(
      ...checkRevision(resolved, original, base.version, {
        userLevel,
        orderQty,
        defects: { defect: (d) => defects.get(d as DefectId) },
        now,
      }),
    );
    const newPhotos = new Map<string, Buffer>();
    failures.push(...checkPhotoParts(resolved, parts, newPhotos));
    if (failures.length > 0) throw checksFailed(failures);
    return { request: resolved, base, poMaster, newPhotos };
  }

  private async checkMaster(id: string, request: RevisionRequest, q: Queryable) {
    const base = await this.revisions.findVersion(id, undefined, q);
    if (!base) throw new ApiProblem('NOT_FOUND', { detail: NOT_FOUND_DETAIL });
    if (request.baseRevisionNo !== base.latestRevisionNo) throw new ApiProblem('REVISION_CONFLICT');

    const failures: Failure[] = [];
    // The PSI at the original's level, active or not; a name only at the other level is a level change.
    const levels = await this.masterData.findUserLevels(request.username, q);
    let userLevel = levels.includes(base.level) ? base.level : (levels[0] ?? null);
    if (levels.length === 0) {
      userLevel = null;
      failures.push({
        path: 'username',
        code: 'USER_NOT_FOUND',
        message: 'Nama tidak ada di daftar PSI.',
      });
    }
    if (!(await this.masterData.findCell(request.factory, request.cell, q))) {
      failures.push({
        path: 'cell',
        code: 'CELL_NOT_FOUND',
        message: 'Factory/Cell tidak ditemukan.',
      });
    }
    let poMaster: Po | null = null;
    let orderQty: number | null = base.version.orderQty;
    if (request.po !== base.version.po) {
      const found = await this.pos.findByPo(request.po, q);
      if (found) {
        poMaster = {
          po: found.po,
          article: found.article,
          model: found.model,
          destination: found.destination,
          orderQty: found.orderQty,
          podd: found.podd,
          crd: found.crd,
        };
        orderQty = found.orderQty;
      } else {
        orderQty = null;
        failures.push({
          path: 'po',
          code: 'PO_NOT_FOUND',
          message: 'PO tidak ditemukan di master PO.',
        });
      }
    }

    // Doc 04 §4.2 rule 4, inactive rows accepted; the family comes from the map row.
    const unique = (values: string[]) => [...new Set(values)];
    const defectRows = await this.masterData.findDefects(
      unique(request.findings.map((f) => f.defectId)),
      q,
    );
    const defects = new Map(
      defectRows.map((d) => [d.id, { name: d.name, classification: d.classification }]),
    );
    const subAreas = new Map(
      (await this.masterData.findSubAreas(unique(request.findings.map((f) => f.subAreaId)), q)).map(
        (s) => [s.id, s],
      ),
    );
    const mapRows = await this.masterData.findMapRows(
      request.findings.map(({ subAreaId, defectId: d }) => ({ subAreaId, defectId: d })),
      q,
    );
    const findings = request.findings.map((f, i): RevisionFinding => {
      const at = `findings[${i}]`;
      if (!defects.has(f.defectId)) {
        failures.push({
          path: `${at}.defectId`,
          code: 'INVALID',
          message: 'Defect tidak ada di master defect.',
        });
      }
      const subArea = subAreas.get(f.subAreaId);
      if (subArea?.areaId !== f.areaId) {
        failures.push({
          path: `${at}.subAreaId`,
          code: 'INVALID',
          message: 'Sub-area bukan bagian dari area ini.',
        });
      }
      const row = mapRowOf(mapRows, f);
      if (defects.has(f.defectId) && subArea?.areaId === f.areaId && !row) {
        failures.push({
          path: at,
          code: 'INVALID',
          message: 'Defect tidak dipetakan ke sub-area ini.',
        });
      }
      return {
        inspectionType: f.inspectionType,
        areaId: f.areaId,
        subAreaId: f.subAreaId,
        familyId: row?.familyId ?? f.familyId ?? '',
        defectId: f.defectId,
        qty: f.qty,
      };
    });
    return { base, failures, poMaster, userLevel, orderQty, defects, findings };
  }

  /** Steps 3–5: the new photos, then one transaction, then the new detail. */
  private async write(
    id: string,
    valid: ValidRevision,
    sha256: string,
    admin: AdminPrincipal,
  ): Promise<RevisionOutcome> {
    const { request, base, poMaster } = valid;
    const revisionNo = base.latestRevisionNo + 1;
    const correctedAt = new Date().toISOString();
    const version = revisionVersion(request, base.version, poMaster, correctedAt);
    const totals = versionTotals(version);
    const changes = revisionChanges(base.version, version);

    const original = await this.database(() => this.revisions.findVersion(id, 0));
    const stored = await this.putPhotos(id, revisionNo, valid, original!.version.sealedAt);

    const insert = async () =>
      this.db.transaction(async (tx) => {
        const latest = await this.revisions.lockForRevision(id, tx);
        if (latest === null) throw new ApiProblem('NOT_FOUND', { detail: NOT_FOUND_DETAIL });
        if (latest !== base.latestRevisionNo) throw new ApiProblem('REVISION_CONFLICT');
        const written = await this.revisions.insert(
          {
            id: request.revisionId,
            submissionId: id,
            revisionNo,
            requestSha256: Buffer.from(sha256, 'hex'),
            adminId: admin.id,
            adminUsername: admin.username,
            reason: request.reason.trim(),
            version,
            totals,
            findings: version.findings,
            photos: stored,
            changes,
          },
          tx,
        );
        if (written) {
          await this.auditLog.append(
            {
              actor: `admin:${admin.username}`,
              action: 'submission.revise',
              entity: 'submissions',
              entityId: id,
              details: { revisionNo, reason: request.reason.trim(), changes },
            },
            tx,
          );
        }
        return written;
      });
    const written = await this.database(async () => {
      try {
        return await insert();
      } catch (error) {
        if (!isRetryableTransactionError(error)) throw error;
        return insert();
      }
    });
    if (!written) {
      // Another process wrote this revision id meanwhile: answer as a repeat.
      const repeat = await this.repeat(id, request.revisionId, sha256);
      if (repeat) return repeat;
    }
    return { status: 201, body: await this.submissions.detail(id) };
  }

  /**
   * New photos under `submissions/<yyyy>/<MM>/<uuid>/r<n>/<defectId>.jpg`, the year and month of the original's key
   * (doc 02 §7); kept photos point to the base's object. Putting the same bytes again is harmless.
   */
  private async putPhotos(
    id: string,
    revisionNo: number,
    valid: ValidRevision,
    originalSealedAt: string,
  ): Promise<NewRevisionPhoto[]> {
    const baseByDefect = new Map(valid.base.photos.map((p) => [p.defectId, p]));
    const result: NewRevisionPhoto[] = [];
    try {
      for (const photo of valid.request.photos) {
        if ('keep' in photo) {
          const kept = baseByDefect.get(photo.defectId)!;
          result.push({
            defectId: photo.defectId,
            objectKey: kept.objectKey,
            sha256: Buffer.from(kept.sha256, 'hex'),
            sizeBytes: kept.sizeBytes,
          });
          continue;
        }
        const bytes = valid.newPhotos.get(photo.defectId)!;
        const key = revisionPhotoKey(id, revisionNo, photo.defectId, originalSealedAt);
        await this.photos.put(key, bytes, photo.sha256);
        result.push({
          defectId: photo.defectId,
          objectKey: key,
          sha256: Buffer.from(photo.sha256, 'hex'),
          sizeBytes: bytes.length,
        });
      }
    } catch (error) {
      this.readiness.reportFailure('PHOTO_STORE', error);
      throw new ApiProblem('PHOTO_STORE_UNAVAILABLE', { retryAfter: RETRY_MS / 1000 });
    }
    return result;
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

/** `submissions/<yyyy>/<MM>/<uuid>/r<n>/<defectId>.jpg` with the year and month of the original's key. */
export function revisionPhotoKey(
  submissionId: string,
  revisionNo: number,
  defect: DefectId,
  originalSealedAt: string,
): string {
  const originalKey = photoKey(submissionId, defect, originalSealedAt);
  return originalKey.replace(`/${submissionId}/`, `/${submissionId}/r${revisionNo}/`);
}

/**
 * The new photo parts: each part named `photo_<DEFECT_ID>` of an entry, a JPEG with the entry's SHA-256, and no part
 * without an entry. Accepted bytes go into `accepted` by defect.
 */
function checkPhotoParts(
  request: RevisionRequest,
  parts: ReadonlyMap<string, Buffer>,
  accepted: Map<string, Buffer>,
): Failure[] {
  const failures: Failure[] = [];
  const named = new Set<string>();
  request.photos.forEach((photo, i) => {
    if ('keep' in photo) return;
    const at = `photos[${i}]`;
    const expected = `photo_${photo.defectId}`;
    if (photo.part !== expected) {
      failures.push({
        path: `${at}.part`,
        code: 'INVALID',
        message: `Nama part harus ${expected}.`,
      });
      return;
    }
    named.add(photo.part);
    const bytes = parts.get(photo.part);
    if (!bytes) {
      failures.push({ path: `${at}.part`, code: 'REQUIRED', message: 'Part foto tidak ada.' });
    } else if (!bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
      failures.push({ path: photo.part, code: 'NOT_JPEG', message: 'Foto bukan JPEG.' });
    } else if (sha256Hex(bytes) !== photo.sha256) {
      failures.push({
        path: `${at}.sha256`,
        code: 'SHA256_MISMATCH',
        message: 'SHA-256 foto tidak cocok.',
      });
    } else {
      accepted.set(photo.defectId, bytes);
    }
  });
  for (const name of parts.keys()) {
    if (!named.has(name)) {
      failures.push({
        path: name,
        code: 'UNKNOWN_PART',
        message: 'Part foto tanpa entri di photos.',
      });
    }
  }
  return failures;
}

function historyItem(entry: HistoryEntry): AdminRevisionHistory['items'][number] {
  return {
    revisionNo: entry.revisionNo,
    at: entry.at.toISOString(),
    by: entry.by,
    reason: entry.reason,
    changes: entry.changes,
  };
}
