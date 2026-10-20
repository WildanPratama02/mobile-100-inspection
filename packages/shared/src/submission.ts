/**
 * SUBMIT PO on the tablet (FR-11 steps 1–3, BR-04, doc 05 §13).
 *
 * `checkSubmit` runs the checks before the confirmation, in the order of doc 05 §13.1. `buildSubmission` turns
 * a session into the `submission` part of `POST /submissions` (doc 04 §4.1); the tablet serialises it once when
 * it seals the session and resends those bytes (doc 03 §4.6). Everything here is pure.
 */
import { findings, type RankedDefect, type SessionState } from './counting';
import type { Cell, DefectId, PoPartial, PsiLevel, SubmissionRequest, User } from './domain';
import { toWibIso } from './format';
import { missingPhotos, takesPhotos } from './photos';

/** Why SUBMIT PO stops before the confirmation; each has its own dialog (doc 05 §13.1). */
export type SubmitBlock =
  | { kind: 'ACTIVE' }
  | { kind: 'EMPTY' }
  /** PSI lv.2: the Top 5 defects without a photo, in rank order (BR-04). */
  | { kind: 'PHOTOS_MISSING'; defects: RankedDefect[] };

export interface SubmitCheckInput {
  state: SessionState;
  level: PsiLevel;
  /** TOP 5 DEFECT of the session (`top5`). */
  top: readonly RankedDefect[];
  /** Defects of the session that have a photo. */
  photographed: ReadonlySet<DefectId>;
}

/** The first failing check, or `null` when the session can be submitted. Reads only. */
export function checkSubmit({
  state,
  level,
  top,
  photographed,
}: SubmitCheckInput): SubmitBlock | null {
  if (state.active) return { kind: 'ACTIVE' };
  const { rework, bGrade, noDefect } = state.counts;
  if (rework + bGrade + noDefect === 0) return { kind: 'EMPTY' };
  if (takesPhotos(level)) {
    const defects = missingPhotos(top, photographed);
    if (defects.length > 0) return { kind: 'PHOTOS_MISSING', defects };
  }
  return null;
}

/** A stored photo as far as the submission needs it. */
export interface PhotoRef {
  defectId: DefectId;
  sha256: string;
}

/**
 * The photos a submission carries: PSI lv.2 only (AC-10.6), one per defect still in the findings, in order of
 * the defect's first finding. A photo stays with a defect that left the Top 5 (AC-10.4); one whose defect was
 * undone completely has no finding to belong to (doc 02 §4.3) and is left out.
 */
export function submissionPhotos<T extends PhotoRef>(
  state: SessionState,
  level: PsiLevel,
  photos: readonly T[],
): T[] {
  if (!takesPhotos(level)) return [];
  const order = [...new Set(findings(state).map((f) => f.defectId))];
  const byDefect = new Map(photos.map((p) => [p.defectId, p]));
  return order.flatMap((id) => {
    const photo = byDefect.get(id);
    return photo ? [photo] : [];
  });
}

export interface SubmissionInput {
  submissionUuid: string;
  sealedAt: string | Date;
  appVersion: string;
  user: User;
  cell: Cell;
  po: string;
  partial: PoPartial | null;
  state: SessionState;
  photos: readonly PhotoRef[];
}

/** The `submission` part of `POST /submissions` (doc 04 §4.1). Times are sent in WIB. */
export function buildSubmission(input: SubmissionInput): SubmissionRequest {
  const { state, user } = input;
  return {
    submissionUuid: input.submissionUuid,
    sealedAt: toWibIso(input.sealedAt),
    appVersion: input.appVersion,
    user: { username: user.username, level: user.level },
    factory: input.cell.factory,
    cell: input.cell.cell,
    po: input.po,
    partial: input.partial ? { number: input.partial.number, qty: input.partial.qty } : null,
    counts: { ...state.counts },
    findings: findings(state).map((f) => ({
      ...f,
      firstRecordedAt: toWibIso(f.firstRecordedAt),
    })),
    photos: submissionPhotos(state, user.level, input.photos).map((p) => ({
      defectId: p.defectId,
      part: `photo_${p.defectId}`,
      sha256: p.sha256,
    })),
  };
}
