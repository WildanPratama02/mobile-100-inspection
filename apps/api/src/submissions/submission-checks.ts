/**
 * The checks of doc 04 §4.2 that need no database: counts against findings, duplicate findings, the partial
 * quantity, the photo rule and the tablet clock. Each returns every failure it finds; nothing here throws.
 */
import {
  allDefects,
  type Classification,
  type DefectId,
  missingPhotos,
  type PhotoRule,
  type SubmissionRequest,
  takesPhotos,
} from '@m100/shared';
import type { Failure } from '../errors/validation';
import { sha256Hex } from './multipart';

/** How far `sealedAt` may be ahead of the server clock (doc 04 §4.2 rule 8, R7). */
export const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

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

/**
 * Rules 3 and 4: at least one inspection, and every finding belongs to an inspection type that was started. The
 * request carries no totals. ADR-019 quantities are checked against findings and the PO's own limits; tapped
 * counts (ADR-021) against the PO's maximum.
 */
export function checkCounts(
  { counts, findings, partial }: SubmissionRequest,
  orderQty: number | null = null,
): Failure[] {
  const failures: Failure[] = [];
  if (counts.noDefect === undefined) {
    const qtyDefect = findings.reduce((sum, f) => sum + f.qty, 0);
    const maximum = partial?.qty ?? orderQty;
    const impossible = maximum !== null && qtyDefect > maximum;
    if (counts.qtyInspection < qtyDefect || impossible) {
      failures.push({
        path: 'counts.qtyInspection',
        code: 'INVALID',
        message: `Qty Inspection minimal ${qtyDefect}: jumlah defect yang tercatat.`,
      });
    }
    if (maximum !== null && (counts.qtyInspection > maximum || impossible)) {
      failures.push({
        path: 'counts.qtyInspection',
        code: 'INVALID',
        message: `Qty Inspection maksimal ${maximum} pasang.`,
      });
    }
  } else {
    // Tapped counts (PSI lv.2, ADR-021): at least one pair, at most the partial quantity or Qty Order.
    const pairs = counts.rework + counts.bGrade + counts.noDefect;
    const maximum = partial?.qty ?? orderQty;
    if (pairs < 1) {
      failures.push({
        path: 'counts',
        code: 'INVALID',
        message: 'Qty Inspection 0: belum ada inspeksi.',
      });
    } else if (maximum !== null && pairs > maximum) {
      failures.push({
        path: 'counts',
        code: 'INVALID',
        message: `Qty Inspection maksimal ${maximum} pasang.`,
      });
    }
  }
  // BR-11 (ADR-022): Rework and Approved, when sent, is at most INSPECTION REWORK QTY; ≥ 0 is in the schema.
  if (counts.reworkApproved !== undefined && counts.reworkApproved > counts.rework) {
    failures.push({
      path: 'counts.reworkApproved',
      code: 'INVALID',
      message: `REWORK AND APPROVED maksimal ${counts.rework} pasang (INSPECTION REWORK QTY).`,
    });
  }
  findings.forEach((f, i) => {
    const started = f.inspectionType === 'REWORK' ? counts.rework : counts.bGrade;
    if (started < 1) {
      failures.push({
        path: `findings[${i}].inspectionType`,
        code: 'INVALID',
        message: `Temuan ${f.inspectionType} tanpa inspeksi ${f.inspectionType}.`,
      });
    }
  });
  return failures;
}

/** Rule 5: one finding per inspection type + area + sub-area + defect. */
export function checkDuplicateFindings({ findings }: SubmissionRequest): Failure[] {
  const seen = new Set<string>();
  const failures: Failure[] = [];
  findings.forEach((f, i) => {
    const key = [f.inspectionType, f.areaId, f.subAreaId, f.defectId].join('|');
    if (seen.has(key)) {
      failures.push({
        path: `findings[${i}]`,
        code: 'DUPLICATE',
        message: 'Temuan ini dikirim dua kali.',
      });
    }
    seen.add(key);
  });
  return failures;
}

/** Rule 6: the partial quantity is at most the PO's ORDER QTY (number 1–99 and qty ≥ 1 are in the schema). */
export function checkPartial({ partial }: SubmissionRequest, orderQty: number | null): Failure[] {
  if (!partial || orderQty === null || partial.qty <= orderQty) return [];
  return [
    {
      path: 'partial.qty',
      code: 'INVALID',
      message: `Qty partial lebih dari ORDER QTY (${orderQty}).`,
    },
  ];
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

  const known = request.findings.filter((f) => defects.has(f.defectId));
  const ranked = allDefects(known, { defect: (id) => defects.get(id) });
  for (const row of missingPhotos(ranked, photographed, storedPhotoRule(request) ?? 'TOP5')) {
    failures.push({
      path: 'photos',
      code: 'PHOTO_MISSING',
      message: `Foto wajib untuk ${row.defectId}.`,
      label: `${row.defectId} ${defects.get(row.defectId)?.name ?? ''}`.trim(),
    });
  }
  return failures;
}

/** Rule 8: `sealedAt` is not more than 5 minutes ahead of the server clock. */
export function checkClock({ sealedAt }: SubmissionRequest, now: Date): Failure[] {
  if (Date.parse(sealedAt) <= now.getTime() + CLOCK_TOLERANCE_MS) return [];
  return [
    {
      path: 'sealedAt',
      code: 'INVALID',
      message: 'Jam tablet lebih dari 5 menit di depan server.',
    },
  ];
}
