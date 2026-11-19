/**
 * The correction form of A1c (doc 05 §20.3a, ADR-024) as plain data: built from the detail of the effective version,
 * turned into the `RevisionRequest` of doc 04 §8.1, and checked with the same shared rules the API applies
 * (`checkRevision`), so the admin sees a problem before saving. No React here; the screen holds the state.
 */
import {
  allDefects,
  checkRevision,
  formatCount,
  partialText,
  type DefectId,
  type InspectionType,
  type NamedDefectLookup,
  type Po,
  type PsiLevel,
  type RevisionChanges,
  type RevisionOriginal,
  type RevisionPhoto,
  type RevisionRequest,
  revisionChanges,
  revisionVersion,
  type RuleFailure,
  type SubmissionVersion,
  type Totals,
  versionTotals,
} from '@m100/shared';
import type { AdminSubmissionDetail } from '../api/types';

/** One finding row of the form; numbers are kept as typed. */
export interface FormFinding {
  /** Stable React key of the row. */
  key: string;
  inspectionType: InspectionType;
  areaId: string;
  subAreaId: string;
  defectId: string;
  qty: string;
}

/** A defect's photo in the form: the one of the effective version, or a new file. */
export type FormPhoto = { kind: 'keep' } | { kind: 'new'; sha256: string; name: string };

export interface CorrectionForm {
  /** `YYYY-MM-DD` and `HH:mm`, WIB. */
  date: string;
  time: string;
  username: string;
  factory: string;
  cell: string;
  po: string;
  partialOn: boolean;
  partialNo: string;
  partialQty: string;
  rework: string;
  bGrade: string;
  reworkApproved: string;
  /** PSI lv.1 (`ADR-019`). */
  qtyInspection: string;
  /** PSI lv.2 (`ADR-008`). */
  noDefect: string;
  findings: FormFinding[];
  photos: Record<string, FormPhoto>;
}

/** The WIB date and time of an ISO moment, `HH:mm` (seconds are not edited). */
export function wibParts(iso: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

let nextKey = 0;
const key = () => `f${++nextKey}`;

export function formFromDetail(d: AdminSubmissionDetail): CorrectionForm {
  const { date, time } = wibParts(d.sealedAt);
  return {
    date,
    time,
    username: d.username,
    factory: d.factory,
    cell: d.cell,
    po: d.po,
    partialOn: d.partial !== null,
    partialNo: d.partial ? String(d.partial.number) : '',
    partialQty: d.partial ? String(d.partial.qty) : '',
    rework: String(d.counts.rework),
    bGrade: String(d.counts.bGrade),
    reworkApproved: String(d.counts.reworkApproved ?? 0),
    qtyInspection: d.countingRule === 'ADR-019' ? String(d.counts.qtyInspection) : '',
    noDefect: d.countingRule === 'ADR-008' ? String(d.counts.noDefect ?? 0) : '',
    findings: d.findings.map((f) => ({
      key: key(),
      inspectionType: f.inspectionType,
      areaId: f.areaId,
      subAreaId: f.subAreaId,
      defectId: f.defectId,
      qty: String(f.qty),
    })),
    photos: Object.fromEntries(d.photos.map((p) => [p.defectId, { kind: 'keep' as const }])),
  };
}

export function newFinding(): FormFinding {
  return {
    key: key(),
    inspectionType: 'REWORK',
    areaId: '',
    subAreaId: '',
    defectId: '',
    qty: '1',
  };
}

/** The version the form starts from, as the shared rules read it. */
export function baseVersion(d: AdminSubmissionDetail): SubmissionVersion {
  return {
    sealedAt: d.sealedAt,
    username: d.username,
    factory: d.factory,
    cell: d.cell,
    po: d.po,
    article: d.article,
    model: d.model,
    destination: d.destination,
    orderQty: d.orderQty,
    podd: d.podd,
    crd: d.crd,
    partial: d.partial,
    counts:
      d.countingRule === 'ADR-008'
        ? {
            rework: d.counts.rework,
            bGrade: d.counts.bGrade,
            reworkApproved: d.counts.reworkApproved,
            noDefect: d.counts.noDefect ?? 0,
          }
        : {
            rework: d.counts.rework,
            bGrade: d.counts.bGrade,
            reworkApproved: d.counts.reworkApproved,
            qtyInspection: d.counts.qtyInspection,
          },
    findings: d.findings.map((f) => ({
      inspectionType: f.inspectionType,
      areaId: f.areaId,
      subAreaId: f.subAreaId,
      familyId: f.familyId,
      defectId: f.defectId,
      qty: f.qty,
      firstRecordedAt: f.firstRecordedAt,
    })),
    photos: d.photos.map((p) => ({ defectId: p.defectId, sha256: `kept:${p.id}` })),
  };
}

export function originalOf(d: AdminSubmissionDetail): RevisionOriginal {
  return { level: d.level, countingRule: d.countingRule, photoRule: d.photoRule };
}

/** A whole number from a field, or `NaN` (refused by the form before anything is sent). */
export function whole(text: string): number {
  return /^\s*\d+\s*$/.test(text) ? Number(text) : NaN;
}

/** The inspection time: unchanged when the date and time are the base's, else the typed minute in WIB. */
export function sealedAtOf(form: CorrectionForm, base: string): string {
  const original = wibParts(base);
  if (form.date === original.date && form.time === original.time) return base;
  return `${form.date}T${form.time}:00.000+07:00`;
}

/** Field problems the form finds before the shared rules (numbers, dates, empty selects). */
export function inputProblems(form: CorrectionForm, d: AdminSubmissionDetail): RuleFailure[] {
  const failures: RuleFailure[] = [];
  const number = (path: string, text: string, label: string) => {
    if (Number.isNaN(whole(text))) {
      failures.push({ path, code: 'INVALID', message: `${label} harus bilangan bulat.` });
    }
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date) || !/^\d{2}:\d{2}$/.test(form.time)) {
    failures.push({ path: 'sealedAt', code: 'INVALID', message: 'Tanggal dan jam wajib diisi.' });
  }
  number('counts.rework', form.rework, 'INSPECTION REWORK QTY');
  number('counts.bGrade', form.bGrade, 'B-GRADE');
  number('counts.reworkApproved', form.reworkApproved, 'REWORK AND APPROVED');
  if (d.countingRule === 'ADR-019')
    number('counts.qtyInspection', form.qtyInspection, 'QTY INSPECTION');
  else number('counts.noDefect', form.noDefect, 'NO DEFECT');
  if (form.partialOn) {
    number('partial.number', form.partialNo, 'Nomor partial');
    number('partial.qty', form.partialQty, 'Qty partial');
  }
  form.findings.forEach((f, i) => {
    if (!f.areaId || !f.subAreaId || !f.defectId) {
      failures.push({
        path: `findings[${i}]`,
        code: 'REQUIRED',
        message: 'Pilih area, sub-area dan defect.',
      });
    }
    if (!(whole(f.qty) >= 1)) {
      failures.push({ path: `findings[${i}].qty`, code: 'INVALID', message: 'Qty minimal 1.' });
    }
  });
  return failures;
}

/** The request of doc 04 §8.1; photos only for defects that still have a finding. */
export function requestFromForm(
  form: CorrectionForm,
  d: AdminSubmissionDetail,
  revisionId: string,
  reason: string,
  /** The family of a map row (the API takes it from the map too; it must not be empty). */
  familyOf: (subAreaId: string, defectId: string) => string = () => '',
): RevisionRequest {
  const withFinding = new Set(form.findings.map((f) => f.defectId));
  const photos: RevisionPhoto[] = [];
  for (const [defectId, photo] of Object.entries(form.photos)) {
    if (!withFinding.has(defectId)) continue;
    photos.push(
      photo.kind === 'keep'
        ? { defectId: defectId as DefectId, keep: true }
        : { defectId: defectId as DefectId, part: `photo_${defectId}`, sha256: photo.sha256 },
    );
  }
  return {
    revisionId,
    baseRevisionNo: d.latestRevisionNo,
    reason,
    sealedAt: sealedAtOf(form, d.sealedAt),
    username: form.username,
    factory: form.factory,
    cell: form.cell,
    po: form.po.trim(),
    partial: form.partialOn ? { number: whole(form.partialNo), qty: whole(form.partialQty) } : null,
    counts: {
      rework: whole(form.rework),
      bGrade: whole(form.bGrade),
      reworkApproved: whole(form.reworkApproved),
      ...(d.countingRule === 'ADR-008'
        ? { noDefect: whole(form.noDefect) }
        : { qtyInspection: whole(form.qtyInspection) }),
    },
    findings: form.findings.map((f) => ({
      inspectionType: f.inspectionType,
      areaId: f.areaId as `A${string}`,
      subAreaId: f.subAreaId,
      familyId: familyOf(f.subAreaId, f.defectId),
      defectId: f.defectId as DefectId,
      qty: whole(f.qty),
    })),
    photos,
  };
}

/** The master answers the shared check needs. */
export interface FormContext {
  /** Levels of the chosen PSI name; empty when unknown. */
  levelsOf: (username: string) => PsiLevel[];
  defects: NamedDefectLookup;
  /** The PO master row when the PO number changed and was found. */
  poMaster: Po | null;
  /** The family of a map row, for the live totals' version. */
  familyOf: (subAreaId: string, defectId: string) => string;
  now: Date;
}

export interface Evaluation {
  problems: RuleFailure[];
  /** `null` while the input itself is not complete. */
  totals: Totals | null;
  changes: RevisionChanges | null;
}

/**
 * Every problem of the form and, when it is complete, the totals and the changes the save would write. `NO_CHANGE`
 * is not a problem here: an unchanged form simply has no changes and cannot be saved.
 */
export function evaluate(
  form: CorrectionForm,
  d: AdminSubmissionDetail,
  context: FormContext,
): Evaluation {
  const problems = inputProblems(form, d);
  if (problems.length > 0) return { problems, totals: null, changes: null };
  const request = requestFromForm(
    form,
    d,
    '00000000-0000-4000-8000-000000000000',
    'x'.repeat(10),
    context.familyOf,
  );
  const base = baseVersion(d);
  const levels = context.levelsOf(request.username);
  const userLevel = levels.includes(d.level) ? d.level : (levels[0] ?? null);
  if (levels.length === 0) {
    problems.push({
      path: 'username',
      code: 'USER_NOT_FOUND',
      message: 'Nama tidak ada di daftar PSI.',
    });
  }
  const orderQty = request.po === d.po ? d.orderQty : (context.poMaster?.orderQty ?? null);
  if (request.po !== d.po && !context.poMaster) {
    problems.push({ path: 'po', code: 'PO_NOT_FOUND', message: 'Pilih PO dari master PO.' });
  }
  problems.push(
    ...checkRevision(request, originalOf(d), base, {
      userLevel,
      orderQty,
      defects: context.defects,
      now: context.now,
    }).filter((p) => p.code !== 'NO_CHANGE' && p.path !== 'reason'),
  );
  const after = revisionVersion(
    request,
    base,
    request.po === d.po ? null : context.poMaster,
    context.now.toISOString(),
  );
  // A new photo has its own SHA-256; a kept one keeps the base's marker, so the changes name replaced photos.
  return { problems, totals: versionTotals(after), changes: revisionChanges(base, after) };
}

/**
 * The defects of the findings in ranking order, each with whether the original's photo rule needs its photo (`ALL`:
 * every one; `TOP5` or none on PSI lv.2: the first five). PSI lv.1 takes no photos: an empty list.
 */
export function photoRows(
  form: CorrectionForm,
  d: AdminSubmissionDetail,
  defects: NamedDefectLookup,
): { defectId: DefectId; required: boolean }[] {
  if (d.level !== 'PSI lv.2') return [];
  const findings = form.findings
    .filter((f) => f.defectId && defects.defect(f.defectId) && whole(f.qty) >= 1)
    .map((f, i) => ({
      inspectionType: f.inspectionType,
      areaId: f.areaId as `A${string}`,
      subAreaId: f.subAreaId,
      familyId: '',
      defectId: f.defectId as DefectId,
      qty: whole(f.qty),
      // Existing defects keep their first tap; new ones rank after them.
      firstRecordedAt:
        d.findings.find((x) => x.defectId === f.defectId)?.firstRecordedAt ??
        new Date(Date.UTC(2100, 0, 1, 0, 0, i)).toISOString(),
    }));
  const ranked = allDefects(findings, defects);
  const all = (d.photoRule ?? 'TOP5') === 'ALL';
  return ranked.map((r, i) => ({ defectId: r.defectId, required: all || i < 5 }));
}

/** `findings[2].qty` → `findings.2`, `counts.qtyInspection` stays: where the screen shows a problem. */
export function fieldOf(path: string): string {
  const m = /^findings\[(\d+)\]/.exec(path);
  if (m) return `findings.${m[1]}`;
  const p = /^photos\[(\d+)\]/.exec(path);
  if (p) return 'photos';
  return path;
}

/** Problems by field, the first message of each. */
export function problemsByField(problems: readonly RuleFailure[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of problems) {
    const field = fieldOf(p.path);
    if (!map.has(field)) map.set(field, p.message);
  }
  return map;
}

/** Labels of the history's changed fields (doc 05 §20.3). */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  sealedAt: 'Waktu',
  username: 'PSI',
  factory: 'Factory',
  cell: 'Cell',
  po: 'PO',
  article: 'Article',
  model: 'Model',
  destination: 'Destination',
  orderQty: 'Order qty',
  podd: 'PODD',
  crd: 'CRD',
  partial: 'PO PARTIAL',
  'counts.rework': 'INSPECTION REWORK QTY',
  'counts.bGrade': 'B-GRADE (pasang)',
  'counts.reworkApproved': 'REWORK AND APPROVED',
  'counts.qtyInspection': 'QTY INSPECTION',
  'counts.noDefect': 'NO DEFECT',
};

/** The changes as lines for the confirmation dialog and the history. */
export function changeLines(
  changes: RevisionChanges,
  show: (field: string, value: unknown) => string,
): string[] {
  const lines = changes.fields.map(
    (c) => `${FIELD_LABELS[c.field] ?? c.field}: ${show(c.field, c.old)} → ${show(c.field, c.new)}`,
  );
  for (const f of changes.findingsAdded)
    lines.push(`Finding baru: ${f.defectId} ${f.inspectionType} (${f.qty})`);
  for (const f of changes.findingsRemoved)
    lines.push(`Finding dihapus: ${f.defectId} ${f.inspectionType} (${f.qty})`);
  for (const f of changes.findingsChanged) {
    lines.push(`Finding ${f.defectId} ${f.inspectionType}: ${f.oldQty} → ${f.qty}`);
  }
  for (const d of changes.photosReplaced) lines.push(`Foto diganti: ${d}`);
  for (const d of changes.photosAdded) lines.push(`Foto baru: ${d}`);
  for (const d of changes.photosRemoved) lines.push(`Foto dihapus: ${d}`);
  return lines;
}

/** One old or new value of the history, as the screen shows it (`moment` formats a time). */
export function changeValue(
  field: string,
  value: unknown,
  orderQty: number,
  moment: (iso: string) => string,
): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'sealedAt' && typeof value === 'string') return moment(value);
  if (field === 'partial' && typeof value === 'object') {
    const p = value as { number: number; qty: number };
    return partialText(p, orderQty);
  }
  if (typeof value === 'number') return formatCount(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
