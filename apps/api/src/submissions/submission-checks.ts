/**
 * The checks of doc 04 §4.2 that need no database: counts against findings, duplicate findings, the partial
 * quantity, the photo rule and the tablet clock. Each returns every failure it finds; nothing here throws. The
 * rules themselves live in `@m100/shared` (`rules.ts`), so an admin correction is checked the same way (ADR-024);
 * the photo entries and bytes are checked here.
 */
import {
  checkClock as sharedCheckClock,
  checkCounts as sharedCheckCounts,
  checkDuplicateFindings as sharedCheckDuplicateFindings,
  checkPartial as sharedCheckPartial,
  type Classification,
  type DefectId,
  type PhotoRule,
  photoCoverage,
  type SubmissionRequest,
  takesPhotos,
} from '@m100/shared';
import type { Failure } from '../errors/validation';
import { sha256Hex } from './multipart';

/** How far `sealedAt` may be ahead of the server clock (doc 04 §4.2 rule 8, R7). */
export { CLOCK_TOLERANCE_MS } from '@m100/shared';

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export interface KnownDefect {
  name: string;
  classification: Classification;
}

export interface CheckContext {
  /** ORDER QTY of the PO; `null` when the PO was not found (reported as `PO_NOT_FOUND`). */
  orderQty: number | null;
  /** The defects of the findings that exist in `defects`; unknown ones are reported by the master checks. */
  defects: ReadonlyMap<string, KnownDefect>;
  now: Date;
}

export function checkSubmission(
  request: SubmissionRequest,
  photos: ReadonlyMap<string, Buffer>,
  context: CheckContext,
): Failure[] {
  return [
    ...checkCounts(request, context.orderQty),
    ...checkDuplicateFindings(request),
    ...checkPartial(request, context.orderQty),
    ...checkPhotos(request, photos, context.defects),
    ...checkClock(request, context.now),
  ];
}

/** Rules 3 and 4 (shared with corrections, ADR-024). */
export function checkCounts(request: SubmissionRequest, orderQty: number | null = null): Failure[] {
  return sharedCheckCounts(request, orderQty);
}

/** Rule 5. */
export function checkDuplicateFindings(request: SubmissionRequest): Failure[] {
  return sharedCheckDuplicateFindings(request);
}

/** Rule 6. */
export function checkPartial(request: SubmissionRequest, orderQty: number | null): Failure[] {
  return sharedCheckPartial(request, orderQty);
}

/**
 * The photo rule a submission is checked and stored with (`submissions.photo_rule`, doc 02 §4.1, §4.3): PSI lv.2
 * `ALL` when the payload carries `photoRule: 'ALL'`, else `TOP5` (payloads sealed by an older app); PSI lv.1
 * `null`, also when its payload carries the marker, which is then ignored (doc 04 §4.1).
 */
export function storedPhotoRule({ user, photoRule }: SubmissionRequest): PhotoRule | null {
  if (!takesPhotos(user.level)) return null;
  return photoRule === 'ALL' ? 'ALL' : 'TOP5';
}

/**
 * Rule 7 (FR-10, BR-04, ADR-022, doc 02 §4.3). PSI lv.1 sends no photo at all. PSI lv.2 sends one photo for each
 * required defect, ranked with the tablet's own `allDefects`: every defect with a finding under `ALL`, the Top 5
 * under `TOP5`, where another photo may belong to a defect that left the Top 5 (AC-10.4). A photo always belongs
 * to a defect with a finding, at most one per defect. Entries and parts match one to one; each part is a JPEG
 * with the entry's SHA-256.
 */
export function checkPhotos(
  request: SubmissionRequest,
  parts: ReadonlyMap<string, Buffer>,
  defects: ReadonlyMap<string, KnownDefect>,
): Failure[] {
  if (!takesPhotos(request.user.level)) {
    return request.photos.length > 0 || parts.size > 0
      ? [{ path: 'photos', code: 'PHOTO_NOT_ALLOWED', message: 'PSI lv.1 tidak mengirim foto.' }]
      : [];
  }

  const failures: Failure[] = [];
  const withFinding = new Set<string>(request.findings.map((f) => f.defectId));
  const photographed = new Set<DefectId>();
  const named = new Set<string>();
  request.photos.forEach((photo, i) => {
    const at = `photos[${i}]`;
    if (photographed.has(photo.defectId)) {
      failures.push({
        path: `${at}.defectId`,
        code: 'DUPLICATE',
        message: 'Lebih dari satu foto untuk defect ini.',
      });
      return;
    }
    photographed.add(photo.defectId);
    if (!withFinding.has(photo.defectId)) {
      failures.push({
        path: `${at}.defectId`,
        code: 'INVALID',
        message: 'Foto untuk defect tanpa temuan.',
      });
    }
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

  failures.push(
    ...photoCoverage(request.findings, photographed, storedPhotoRule(request) ?? 'TOP5', {
      defect: (id) => defects.get(id),
    }),
  );
  return failures;
}

/** Rule 8: `sealedAt` is not more than 5 minutes ahead of the server clock. */
export function checkClock({ sealedAt }: SubmissionRequest, now: Date): Failure[] {
  return sharedCheckClock(sealedAt, now);
}
