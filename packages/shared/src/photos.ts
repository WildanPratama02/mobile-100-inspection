/**
 * Photo rules (FR-10, BR-04, ADR-022).
 *
 * New PSI lv.2 sessions require one photo per finding defect; older sealed payloads retain Top 5.
 * PSI lv.1 never attaches any (AC-10.6). A photo belongs to a DEFECT_ID, not a rank (AC-10.4).
 */
import type { DefectId, PhotoRule, PsiLevel } from './domain';
import type { RankedDefect } from './counting';
import { inspectionDate } from './format';

/** Whether a PSI of this level takes photos at all (AC-10.6). */
export function takesPhotos(level: PsiLevel): boolean {
  return level === 'PSI lv.2';
}

/** Required defects without a photo, in rank order. Pass the full ranking for ALL (BR-04). */
export function missingPhotos(
  ranked: readonly RankedDefect[],
  photographed: ReadonlySet<DefectId>,
  photoRule: PhotoRule = 'ALL',
): RankedDefect[] {
  const required = photoRule === 'TOP5' ? ranked.slice(0, 5) : ranked;
  return required.filter((row) => !photographed.has(row.defectId));
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
