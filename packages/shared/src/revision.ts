/**
 * Admin corrections of a submission (ADR-023, PRD FR-17, doc 02 §4.4, §6.5, doc 04 §8.1). A correction is a
 * complete new version, checked with the same rules as a submission (`rules.ts`) for the original's counting and
 * photo rule. The master lookups (does the PSI, the cell, the PO exist) are the API's; everything here is pure.
 */
import { computeTotals, type Totals } from './counting';
import type {
  DefectId,
  Finding,
  Po,
  PoPartial,
  PsiLevel,
  RevisionOriginal,
  RevisionRequest,
  SubmissionCounts,
  SubmissionVersion,
  VersionCounts,
} from './domain';
import { takesPhotos } from './photos';
import {
  checkClock,
  checkCounts,
  checkDuplicateFindings,
  checkPartial,
  findingKey,
  type NamedDefectLookup,
  photoCoverage,
  type RuleFailure,
} from './rules';

/** Length of a correction's reason after trimming (doc 02 §4.4 CHECK). */
export const REASON_MIN = 10;
export const REASON_MAX = 500;

/** What `checkRevision` needs besides the request: answers of the master tables and the clock. */
export interface RevisionContext {
  /** Level of the chosen PSI; `null` when the name is unknown (the API reports `USER_NOT_FOUND` itself). */
  userLevel: PsiLevel | null;
  /** Qty Order of the request's PO: the master's for a changed PO, else the base's; `null` when unknown. */
  orderQty: number | null;
  defects: NamedDefectLookup;
  now: Date;
}

/**
 * Every problem of a correction, in one list (doc 04 §8.1); empty means it may be written. `base` is the version
 * it was made from (the effective version when `baseRevisionNo` is current).
 */
export function checkRevision(
  request: RevisionRequest,
  original: RevisionOriginal,
  base: SubmissionVersion,
  context: RevisionContext,
): RuleFailure[] {
  const failures: RuleFailure[] = [];

  const reason = request.reason.trim().length;
  if (reason < REASON_MIN || reason > REASON_MAX) {
    failures.push({
      path: 'reason',
      code: 'INVALID',
      message: `Alasan koreksi ${REASON_MIN}–${REASON_MAX} karakter.`,
    });
  }

  if (context.userLevel !== null && context.userLevel !== original.level) {
    failures.push({
      path: 'username',
      code: 'LEVEL_CHANGE',
      message: `PSI harus ${original.level}: level tidak bisa dikoreksi.`,
    });
  }

  failures.push(...checkCountsField(request, original));
  failures.push(...checkCounts(request, context.orderQty));
  failures.push(...checkDuplicateFindings(request));
  failures.push(...checkPartial(request, context.orderQty));
  failures.push(...checkRevisionPhotos(request, original, base, context.defects, context.now));
  failures.push(...checkClock(request.sealedAt, context.now));

  if (failures.length === 0) {
    const after = revisionVersion(request, base, null, context.now.toISOString());
    if (!hasChanges(revisionChanges(base, after))) {
      failures.push({ path: '', code: 'NO_CHANGE', message: 'Tidak ada perubahan.' });
    }
  }
  return failures;
}

/** The counts must have the original's form: `qtyInspection` for `ADR-019`, `noDefect` for `ADR-008`. */
function checkCountsField(request: RevisionRequest, original: RevisionOriginal): RuleFailure[] {
  const failures: RuleFailure[] = [];
  const { counts } = request;
  const entered = counts.qtyInspection !== undefined;
  const tapped = counts.noDefect !== undefined;
  if (original.countingRule === 'ADR-019' && (!entered || tapped)) {
    failures.push({
      path: 'counts',
      code: 'INVALID',
      message: 'Hitungan harus QTY INSPECTION, tanpa NO DEFECT (QTY INSPECTION diisi PSI).',
    });
  }
  if (original.countingRule === 'ADR-008' && (!tapped || entered)) {
    failures.push({
      path: 'counts',
      code: 'INVALID',
      message: 'Hitungan harus NO DEFECT, tanpa QTY INSPECTION (hitung per tap).',
    });
  }
  if (typeof counts.reworkApproved !== 'number') {
    failures.push({
      path: 'counts.reworkApproved',
      code: 'REQUIRED',
      message: 'REWORK AND APPROVED wajib diisi (0 bila kosong).',
    });
  }
  return failures;
}

/**
 * Rule 7 for a correction: PSI lv.1 sends no photo; PSI lv.2 at most one entry per defect, each for a defect with
 * a finding, a `keep` only where the base has a photo of that defect, and coverage by the original's photo rule
 * (`TOP5` when it has none). The new parts' bytes are checked by the API.
 */
function checkRevisionPhotos(
  request: RevisionRequest,
  original: RevisionOriginal,
  base: SubmissionVersion,
  defects: NamedDefectLookup,
  now: Date,
): RuleFailure[] {
  if (!takesPhotos(original.level)) {
    return request.photos.length > 0
      ? [{ path: 'photos', code: 'PHOTO_NOT_ALLOWED', message: 'PSI lv.1 tidak mengirim foto.' }]
      : [];
  }
  const failures: RuleFailure[] = [];
  const withFinding = new Set<string>(request.findings.map((f) => f.defectId));
  const inBase = new Set<string>(base.photos.map((p) => p.defectId));
  const photographed = new Set<DefectId>();
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
    if ('keep' in photo && !inBase.has(photo.defectId)) {
      failures.push({
        path: `${at}.keep`,
        code: 'INVALID',
        message: `Tidak ada foto lama untuk ${photo.defectId}.`,
      });
    }
  });
  failures.push(
    ...photoCoverage(
      withFirstRecorded(request.findings, base, now.toISOString()),
      photographed,
      original.photoRule ?? 'TOP5',
      defects,
    ),
  );
  return failures;
}

/**
 * The new version a correction writes (doc 02 §4.4, ADR-023 decision 6). A changed PO takes article, model,
 * destination, Qty Order, PODD and CRD from `poMaster` (required then); an unchanged PO keeps the base's
 * snapshot. A finding keeps the `firstRecordedAt` of the base finding with the same identity, else of the base's
 * first finding of the same defect, else gets `correctedAt`, so the ranking ties stay as the PSI recorded them.
 * A kept photo keeps the base's SHA-256.
 */
export function revisionVersion(
  request: RevisionRequest,
  base: SubmissionVersion,
  poMaster: Po | null,
  correctedAt: string,
): SubmissionVersion {
  let snapshot: Pick<
    SubmissionVersion,
    'article' | 'model' | 'destination' | 'orderQty' | 'podd' | 'crd'
  > = base;
  if (request.po !== base.po) {
    if (poMaster) {
      if (poMaster.po !== request.po)
        throw new Error(`PO master ${poMaster.po} is not ${request.po}`);
      snapshot = poMaster;
    }
    // Without the master (checkRevision's change test) the PO number alone already makes it a change.
  }
  const baseSha = new Map(base.photos.map((p) => [p.defectId, p.sha256]));
  return {
    sealedAt: request.sealedAt,
    username: request.username,
    factory: request.factory,
    cell: request.cell,
    po: request.po,
    article: snapshot.article,
    model: snapshot.model,
    destination: snapshot.destination,
    orderQty: snapshot.orderQty,
    podd: snapshot.podd,
    crd: snapshot.crd,
    partial: request.partial ? { number: request.partial.number, qty: request.partial.qty } : null,
    counts: versionCounts(request.counts),
    findings: withFirstRecorded(request.findings, base, correctedAt),
    photos: request.photos.map((p) => ({
      defectId: p.defectId,
      sha256: 'keep' in p ? (baseSha.get(p.defectId) ?? '') : p.sha256,
    })),
  };
}

function versionCounts(counts: RevisionRequest['counts']): VersionCounts {
  const common = {
    rework: counts.rework,
    bGrade: counts.bGrade,
    reworkApproved: counts.reworkApproved,
  };
  return counts.noDefect !== undefined
    ? { ...common, noDefect: counts.noDefect }
    : { ...common, qtyInspection: counts.qtyInspection ?? 0 };
}

function withFirstRecorded(
  list: RevisionRequest['findings'],
  base: SubmissionVersion,
  correctedAt: string,
): Finding[] {
  const byKey = new Map(base.findings.map((f) => [findingKey(f), f.firstRecordedAt]));
  const byDefect = new Map<string, string>();
  for (const f of base.findings) {
    const known = byDefect.get(f.defectId);
    if (known === undefined || Date.parse(f.firstRecordedAt) < Date.parse(known)) {
      byDefect.set(f.defectId, f.firstRecordedAt);
    }
  }
  return list.map((f) => ({
    inspectionType: f.inspectionType,
    areaId: f.areaId,
    subAreaId: f.subAreaId,
    familyId: f.familyId,
    defectId: f.defectId,
    qty: f.qty,
    firstRecordedAt: byKey.get(findingKey(f)) ?? byDefect.get(f.defectId) ?? correctedAt,
  }));
}

/** The totals of a version, with the rules of its counts (ADR-019 entered, ADR-008 tapped). */
export function versionTotals(version: Pick<SubmissionVersion, 'counts' | 'findings'>): Totals {
  const { counts } = version;
  const submitted: SubmissionCounts =
    counts.noDefect !== undefined
      ? { rework: counts.rework, bGrade: counts.bGrade, noDefect: counts.noDefect }
      : { rework: counts.rework, bGrade: counts.bGrade, qtyInspection: counts.qtyInspection };
  return computeTotals(submitted, version.findings);
}

type Value = string | number | null | PoPartial;

/** One changed field with its old and new value. */
export interface FieldChange {
  field: string;
  old: Value;
  new: Value;
}

/** A finding as the history names it. */
export interface FindingChangeRef {
  inspectionType: Finding['inspectionType'];
  areaId: Finding['areaId'];
  subAreaId: string;
  defectId: DefectId;
  qty: number;
}

/** What a correction changed (`submission_revisions.changes`, the history and the audit log, doc 02 §4.4). */
export interface RevisionChanges {
  fields: FieldChange[];
  findingsAdded: FindingChangeRef[];
  findingsRemoved: FindingChangeRef[];
  findingsChanged: (FindingChangeRef & { oldQty: number; oldFamilyId?: string })[];
  photosAdded: DefectId[];
  photosReplaced: DefectId[];
  photosRemoved: DefectId[];
}

const HEADER_FIELDS = [
  'username',
  'factory',
  'cell',
  'po',
  'article',
  'model',
  'destination',
  'orderQty',
  'podd',
  'crd',
] as const;

const COUNT_FIELDS = ['rework', 'bGrade', 'reworkApproved', 'qtyInspection', 'noDefect'] as const;

/** The changes from `before` to `after`; empty lists and no fields when they are the same version. */
export function revisionChanges(
  before: SubmissionVersion,
  after: SubmissionVersion,
): RevisionChanges {
  const fields: FieldChange[] = [];
  if (Date.parse(before.sealedAt) !== Date.parse(after.sealedAt)) {
    fields.push({ field: 'sealedAt', old: before.sealedAt, new: after.sealedAt });
  }
  for (const field of HEADER_FIELDS) {
    if (before[field] !== after[field]) {
      fields.push({ field, old: before[field], new: after[field] });
    }
  }
  if (!samePartial(before.partial, after.partial)) {
    fields.push({ field: 'partial', old: before.partial, new: after.partial });
  }
  for (const name of COUNT_FIELDS) {
    const old = before.counts[name] ?? null;
    const now = after.counts[name] ?? null;
    if (old !== now) fields.push({ field: `counts.${name}`, old, new: now });
  }

  const ref = (f: Finding): FindingChangeRef => ({
    inspectionType: f.inspectionType,
    areaId: f.areaId,
    subAreaId: f.subAreaId,
    defectId: f.defectId,
    qty: f.qty,
  });
  const old = new Map(before.findings.map((f) => [findingKey(f), f]));
  const now = new Map(after.findings.map((f) => [findingKey(f), f]));
  const findingsAdded = [...now].filter(([k]) => !old.has(k)).map(([, f]) => ref(f));
  const findingsRemoved = [...old].filter(([k]) => !now.has(k)).map(([, f]) => ref(f));
  const findingsChanged: RevisionChanges['findingsChanged'] = [];
  for (const [key, f] of now) {
    const was = old.get(key);
    if (was && (was.qty !== f.qty || was.familyId !== f.familyId)) {
      findingsChanged.push({
        ...ref(f),
        oldQty: was.qty,
        ...(was.familyId !== f.familyId ? { oldFamilyId: was.familyId } : {}),
      });
    }
  }

  const oldPhotos = new Map(before.photos.map((p) => [p.defectId, p.sha256]));
  const newPhotos = new Map(after.photos.map((p) => [p.defectId, p.sha256]));
  const photosAdded = [...newPhotos.keys()].filter((d) => !oldPhotos.has(d));
  const photosRemoved = [...oldPhotos.keys()].filter((d) => !newPhotos.has(d));
  const photosReplaced = [...newPhotos]
    .filter(([d, sha]) => oldPhotos.has(d) && oldPhotos.get(d) !== sha)
    .map(([d]) => d);

  return {
    fields,
    findingsAdded,
    findingsRemoved,
    findingsChanged,
    photosAdded,
    photosReplaced,
    photosRemoved,
  };
}

function samePartial(a: PoPartial | null, b: PoPartial | null): boolean {
  if (a === null || b === null) return a === b;
  return a.number === b.number && a.qty === b.qty;
}

/** Whether a correction changes anything (`NO_CHANGE` otherwise). */
export function hasChanges(changes: RevisionChanges): boolean {
  return (
    changes.fields.length > 0 ||
    changes.findingsAdded.length > 0 ||
    changes.findingsRemoved.length > 0 ||
    changes.findingsChanged.length > 0 ||
    changes.photosAdded.length > 0 ||
    changes.photosReplaced.length > 0 ||
    changes.photosRemoved.length > 0
  );
}
