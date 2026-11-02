/**
 * What EXPORT PDF and EXPORT EXCEL put in their files (FR-12, AC-12.1, doc 05 §8.5), derived from the selected
 * PO's open session with `@m100/shared`. Both files are drawn from this one model, so they never disagree, and
 * building it only reads: the session, its photos and Dexie stay as they were (AC-12.4).
 */
import {
  APP_NAME,
  countingMode,
  emptySession,
  findings,
  formatDate,
  formatPartial,
  inspectionDate,
  missingPhotos,
  rankDefects,
  takesPhotos,
  totals,
  type Classification,
  type DefectId,
  type MappingIndex,
} from '@m100/shared';
import { areaLabels } from '../app/mapping';
import type { Auth, PoRow } from '../db/schema';
import type { PoSession } from '../state/store';

/** The header title of the PDF (ADR-010). */
export const EXPORT_TITLE = APP_NAME.toUpperCase();

/** Shown in place of the defect list of an empty session (doc 05 §8.5). */
export const NO_DEFECT_TEXT = 'Belum ada defect.';

/** A count, or a rate printed as a percentage; every null figure is shown as `0` / `0,0%` (31 Oct 2026). */
export type ResultValue =
  { label: string; kind: 'count'; value: number } | { label: string; kind: 'rate'; value: number };

/** A Part III row: a count, or a text field (PO NO, Model Name, Destination). */
export interface SummaryRow {
  label: string;
  value: string | number;
}

/** One row of the Defect Findings List / DEFECT FINDINGS table, in ranking order (AC-12.1). */
export interface ExportDefect {
  no: number;
  defectId: DefectId;
  name: string;
  classification: Classification;
  areas: string;
  qty: number;
  /** Its share of QTY INSPECTION; `0` while QTY INSPECTION is empty or 0 (BR-02). */
  rate: number;
}

export interface ExportPhoto {
  defectId: DefectId;
  name: string;
  /** Its row in DEFECT FINDINGS (AC-10.4). */
  no: number;
  blob: Blob;
}

export interface ExportReport {
  /** `PSI_<PO>_<YYYYMMDD>`, without the extension (AC-12.3). */
  fileBase: string;
  /** The session's WIB inspection date, `YYYY-MM-DD`; never the export time (AC-12.3). */
  date: string;
  /** The inspector and level, as Part I PSI Name shows them. */
  psiName: string;
  /** Labelled values of the PDF header: PO info, inspector, Factory/Cell and the inspection date. */
  info: Array<[label: string, value: string]>;
  /** The PDF results row (ADR-022 decision 7). */
  results: ResultValue[];
  /** Excel Part II: KPI Summary. */
  kpi: ResultValue[];
  /** Excel Part III: Daily Inspection Summary, one PO session. */
  summary: SummaryRow[];
  /** Every finding defect, ranked; the files no longer stop at five (ADR-022). */
  defects: ExportDefect[];
  /** Every photo of a defect in the current findings, in ranking order, each once (AC-12.2). */
  photos: ExportPhoto[];
  /**
   * PSI lv.2: every defect name without a photo, in ranking order. Exporting is refused while any is left (BR-04,
   * ADR-022).
   */
  missingPhotos: string[];
}

export interface ExportInput {
  po: PoRow;
  session: PoSession | undefined;
  auth: Auth;
  mapping: MappingIndex;
}

export function exportReport({ po, session, auth, mapping }: ExportInput): ExportReport {
  const state = session?.state ?? emptySession(countingMode(auth.level));
  const attached = session?.photos ?? {};
  const photos = takesPhotos(auth.level);

  const defectOf = (id: DefectId) => {
    const defect = mapping.defect(id);
    if (!defect) throw new Error(`Unknown defect ${id}`);
    return defect;
  };

  const list = findings(state);
  const ranked = rankDefects(list, (id) => defectOf(id).classification);
  const t = totals(state, po);
  const count = (n: number | null) => n ?? 0;
  /**
   * A defect's share of QTY INSPECTION, only while QTY INSPECTION is valid: Defect Rate is null exactly when it is
   * empty, not valid (BR-10) or 0, and every figure that needs a valid QTY INSPECTION is then 0,0% (31 Oct 2026),
   * so the rows always agree with Defect Rate.
   */
  const share = (qty: number) =>
    t.defectRate === null || t.qtyInspection === null ? 0 : qty / t.qtyInspection;

  // AC-12.3: the WIB date of the session's first recorded event, else of its creation. Export time never enters.
  const date = inspectionDate(session?.events[0]?.at ?? session?.session.createdAt ?? po.addedAt);
  const psiName = `${auth.username} (${auth.level})`;

  const info: Array<[string, string]> = [
    ['PO NUMBER', po.po],
    ['ARTIKEL', po.article],
    ['MODEL', po.model],
    ['DESTINATION', po.destination],
  ];
  if (po.partial) info.push(['PARTIAL', formatPartial(po.partial, po.orderQty)]);
  info.push(
    ['INSPEKTOR', psiName],
    ['FACTORY/CELL', auth.cell],
    ['DATE INSPECTION', formatDate(date)],
  );

  return {
    fileBase: `PSI_${po.po}_${date.replaceAll('-', '')}`,
    date,
    psiName,
    info,
    results: [
      { label: 'Qty PO Order', kind: 'count', value: po.orderQty },
      { label: 'Qty Inspection', kind: 'count', value: count(t.qtyInspection) },
      { label: 'INSPECTION REWORK QTY', kind: 'count', value: t.inspectionReworkQty },
      { label: 'Qty Defect', kind: 'count', value: t.qtyDefect },
      { label: 'Qty A-Grade', kind: 'count', value: count(t.qtyAGrade) },
      { label: 'Qty B-Grade', kind: 'count', value: t.qtyBGrade },
      { label: 'REWORK AND APPROVED', kind: 'count', value: count(t.reworkApproved) },
      { label: 'Defect Rate', kind: 'rate', value: count(t.defectRate) },
      { label: 'Pass Rate (RFT)', kind: 'rate', value: count(t.passRate) },
    ],
    kpi: [
      { label: 'Inspected Qty', kind: 'count', value: count(t.qtyInspection) },
      {
        label: 'Inspected Qty (Including Rework)',
        kind: 'count',
        value: count(t.inspectedQtyInclRework),
      },
      { label: 'Rejected Order Qty', kind: 'count', value: count(t.rejectedQty) },
      { label: 'RFT %', kind: 'rate', value: count(t.passRate) },
      { label: 'Defect %', kind: 'rate', value: count(t.defectRate) },
      { label: 'Not Reworkable Defect Qty', kind: 'count', value: t.qtyBGrade },
      { label: 'Not Reworkable Defect %', kind: 'rate', value: count(t.notReworkableRate) },
      { label: 'Total Approved Qty', kind: 'count', value: count(t.totalApprovedQty) },
    ],
    summary: [
      // Labels exactly as the template's column A, rows 25–37 (ADR-022 decision 9, 2 Nov 2026).
      { label: 'PO NO', value: po.po },
      { label: 'Model Name', value: po.model },
      { label: 'Qty Order', value: po.orderQty },
      { label: 'Destination', value: po.destination },
      { label: 'Offered Lot Qty', value: count(t.offeredLotQty) },
      { label: 'Inspected Qty', value: count(t.qtyInspection) },
      {
        label: 'Inspected Qty (Including Rework)',
        value: count(t.inspectedQtyInclRework),
      },
      { label: 'Approved Qty', value: count(t.qtyAGrade) },
      { label: 'Rejected Qty', value: count(t.rejectedQty) },
      { label: 'Rework and Approved', value: count(t.reworkApproved) },
      {
        label: 'Pairs Not Reworkable & Not Shippable (B&C Grade)',
        value: t.qtyBGrade,
      },
      { label: 'Balance Rework', value: count(t.balanceRework) },
      { label: 'Balance Qty', value: count(t.balanceQty) },
    ],
    defects: ranked.map((row, i) => ({
      no: i + 1,
      defectId: row.defectId,
      name: defectOf(row.defectId).name,
      classification: row.classification,
      areas: areaLabels(row.areaIds, mapping),
      qty: row.qty,
      rate: share(row.qty),
    })),
    // A photo of a defect that was undone completely is not part of the findings and stays out.
    photos: ranked.flatMap((row, i) => {
      const photo = attached[row.defectId];
      return photo
        ? [
            {
              defectId: row.defectId,
              name: defectOf(row.defectId).name,
              no: i + 1,
              blob: photo.blob,
            },
          ]
        : [];
    }),
    missingPhotos: photos
      ? missingPhotos(ranked, new Set(Object.keys(attached) as DefectId[]), 'ALL').map(
          (row) => defectOf(row.defectId).name,
        )
      : [],
  };
}
