/**
 * Photo rules (FR-10, BR-04, ADR-011).
 *
 * PSI lv.2 attaches exactly one photo to every Top 5 defect before Submit PO; PSI lv.1 never attaches any
 * (AC-10.6). A photo belongs to a defect, not a rank, so one may also belong to a defect outside the Top 5
 * (AC-10.4). Home, the exports, sealing and the API's `PHOTO_MISSING` check all use these.
 */
import type { DefectId, PsiLevel } from './domain';
import type { RankedDefect } from './counting';
import { inspectionDate } from './format';

/** Whether a PSI of this level takes photos at all (AC-10.6). */
export function takesPhotos(level: PsiLevel): boolean {
  return level === 'PSI lv.2';
}

/** The Top 5 defects that still have no photo, in rank order (BR-04). */
export function missingPhotos(
  top: readonly RankedDefect[],
  photographed: ReadonlySet<DefectId>,
): RankedDefect[] {
  return top.filter((row) => !photographed.has(row.defectId));
}

/**
 * Where a submission's photo lives in the photo store: `submissions/<yyyy>/<MM>/<uuid>/<defectId>.jpg`, the year
 * and month of `sealedAt` in WIB (doc 02 §7). The same inputs always give the same key, so a retry overwrites
 * its own photo (doc 02 §6.1).
 */
export function photoKey(
  submissionUuid: string,
  defectId: DefectId,
  sealedAt: string | Date,
): string {
  const [year, month] = inspectionDate(sealedAt).split('-');
  return `submissions/${year}/${month}/${submissionUuid}/${defectId}.jpg`;
}
