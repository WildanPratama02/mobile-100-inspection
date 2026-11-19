/**
 * The checks of doc 04 §4.2 that need neither the database nor the photo bytes: counts against findings
 * (rules 3–4), duplicate findings (rule 5), the partial quantity (rule 6), photo coverage (rule 7) and the tablet
 * clock (rule 8). Used by the API for a submission and, with the same messages, for an admin correction
 * (ADR-023), and by the admin app to show the same problems while the form is filled. Nothing here throws.
 */
import { allDefects, type DefectLookup } from './counting';
import type {
  Classification,
  DefectId,
  Finding,
  InspectionCounts,
  PhotoRule,
  PoPartial,
} from './domain';
import { missingPhotos } from './photos';

/** One failed check (`errors[]` of a `422`, doc 04 §6). `label` names a missing photo's defect for `detail`. */
export interface RuleFailure {
  path: string;
  code: string;
  message: string;
  label?: string;
}

/** How far `sealedAt` may be ahead of the server clock (doc 04 §4.2 rule 8, R7). */
export const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

/** Counts as they are checked: entered (`qtyInspection`, ADR-019) or tapped (`noDefect`, ADR-008). */
export type CheckedCounts = InspectionCounts & {
  reworkApproved?: number | null;
  qtyInspection?: number;
  noDefect?: number;
};

/** The part of a submission or a correction that rules 3–6 read. */
export interface CountedData {
  counts: CheckedCounts;
  findings: readonly Pick<
    Finding,
    'inspectionType' | 'areaId' | 'subAreaId' | 'defectId' | 'qty'
  >[];
  partial: PoPartial | null;
}

/**
 * Rules 3 and 4: ADR-019 quantities against the findings and the PO's limits (BR-10), tapped counts (ADR-021)
 * against the PO's maximum, Rework and Approved against INSPECTION REWORK QTY (BR-11), and every finding belongs
 * to an inspection type that was started. `orderQty` is `null` when the PO is unknown (reported elsewhere).
 */
export function checkCounts(
  { counts, findings, partial }: CountedData,
  orderQty: number | null = null,
): RuleFailure[] {
  const failures: RuleFailure[] = [];
  const maximum = partial?.qty ?? orderQty;
  if (counts.noDefect === undefined) {
    const qtyInspection = counts.qtyInspection ?? 0;
    const qtyDefect = findings.reduce((sum, f) => sum + f.qty, 0);
    const impossible = maximum !== null && qtyDefect > maximum;
    if (qtyInspection < qtyDefect || impossible) {
      failures.push({
        path: 'counts.qtyInspection',
        code: 'INVALID',
        message: `Qty Inspection minimal ${qtyDefect}: jumlah defect yang tercatat.`,
      });
    }
    if (maximum !== null && (qtyInspection > maximum || impossible)) {
      failures.push({
        path: 'counts.qtyInspection',
        code: 'INVALID',
        message: `Qty Inspection maksimal ${maximum} pasang.`,
      });
    }
  } else {
    // Tapped counts (PSI lv.2, ADR-021): at least one pair, at most the partial quantity or Qty Order.
    const pairs = counts.rework + counts.bGrade + counts.noDefect;
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
  if (
    counts.reworkApproved !== undefined &&
    counts.reworkApproved !== null &&
    counts.reworkApproved > counts.rework
  ) {
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

/** The identity of a finding: inspection type + area + sub-area + defect (doc 02 §4.2). */
export function findingKey(
  f: Pick<Finding, 'inspectionType' | 'areaId' | 'subAreaId' | 'defectId'>,
): string {
  return [f.inspectionType, f.areaId, f.subAreaId, f.defectId].join('|');
}

/** Rule 5: one finding per inspection type + area + sub-area + defect. */
export function checkDuplicateFindings({ findings }: Pick<CountedData, 'findings'>): RuleFailure[] {
  const seen = new Set<string>();
  const failures: RuleFailure[] = [];
  findings.forEach((f, i) => {
    const key = findingKey(f);
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
export function checkPartial(
  { partial }: Pick<CountedData, 'partial'>,
  orderQty: number | null,
): RuleFailure[] {
  if (!partial || orderQty === null || partial.qty <= orderQty) return [];
  return [
    {
      path: 'partial.qty',
      code: 'INVALID',
      message: `Qty partial lebih dari ORDER QTY (${orderQty}).`,
    },
  ];
}

/** A defect as the photo check needs it: its severity for the ranking, its name for the message label. */
export interface NamedDefectLookup extends DefectLookup {
  defect(id: string): { classification: Classification; name?: string } | undefined;
}

/**
 * Rule 7, coverage only (FR-10, BR-04, ADR-022): the required defects without a photo, as `PHOTO_MISSING`, ranked
 * with `allDefects` over the findings whose defect is known: every defect with a finding under `ALL`, the Top 5
 * under `TOP5`. The checks of the photo entries and bytes are the caller's.
 */
export function photoCoverage(
  findings: readonly Finding[],
  photographed: ReadonlySet<DefectId>,
  photoRule: PhotoRule,
  defects: NamedDefectLookup,
): RuleFailure[] {
  const known = findings.filter((f) => defects.defect(f.defectId) !== undefined);
  const ranked = allDefects(known, defects);
  return missingPhotos(ranked, photographed, photoRule).map((row) => ({
    path: 'photos',
    code: 'PHOTO_MISSING',
    message: `Foto wajib untuk ${row.defectId}.`,
    label: `${row.defectId} ${defects.defect(row.defectId)?.name ?? ''}`.trim(),
  }));
}

/** Rule 8: `sealedAt` is not more than 5 minutes ahead of the server clock. */
export function checkClock(sealedAt: string, now: Date): RuleFailure[] {
  if (Date.parse(sealedAt) <= now.getTime() + CLOCK_TOLERANCE_MS) return [];
  return [
    {
      path: 'sealedAt',
      code: 'INVALID',
      message: 'Jam tablet lebih dari 5 menit di depan server.',
    },
  ];
}
