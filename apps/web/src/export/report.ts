/**
 * What EXPORT PDF and EXPORT EXCEL put in their files (FR-12, AC-12.1), built from the PO's sealed submission in
 * the outbox: exporting is only possible after SUBMIT PO, and both files describe exactly what was sent (doc 03
 * §4.6). Both files are drawn from this one model, so they never disagree, and building it only reads (AC-12.4).
 */
import {
  APP_NAME,
  emptySession,
  findings,
  formatDate,
  formatDateTime,
  formatPartial,
  inspectionDate,
  missingPhotos,
  rankDefects,
  takesPhotos,
  totals,
  type Classification,
  type DefectId,
  type MappingIndex,
  type RecordedDefect,
  type SessionState,
  type SubmissionRequest,
} from '@m100/shared';
import { areaLabels } from '../app/mapping';
import type {
  CorrectionPhotoRow,
  CorrectionRow,
  OutboxPhotoRow,
  OutboxRow,
  PoRow,
} from '../db/schema';

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
  /** The submission's inspection date (WIB date of `sealedAt`), `YYYY-MM-DD`; never the export time (AC-12.3). */
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
  /** Every photo of a defect in the submission's findings, in ranking order, each once (AC-12.2). */
  photos: ExportPhoto[];
  /**
   * PSI lv.2: every required defect name without a photo, in ranking order. Always empty for a sealed submission:
   * it passed BR-04 at SUBMIT PO; the field keeps the report shape.
   */
  missingPhotos: string[];
  /**
   * The admin correction the file was made from (ADR-024, AC-12.5): the PDF prints "DIKOREKSI ADMIN · REVISI n ·
   * time" under its title and Excel Part I gets a Correction row; `null` for the sealed submission.
   */
  correction: { revisionNo: number; correctedAt: string } | null;
}

/** The PDF line and the Excel value of a correction (doc 05 §8.5, §15). */
export function correctionMark(correction: { revisionNo: number; correctedAt: string }): {
  pdf: string;
  excel: string;
} {
  const at = formatDateTime(new Date(correction.correctedAt));
  return {
    pdf: `DIKOREKSI ADMIN · REVISI ${correction.revisionNo} · ${at}`,
    excel: `Revisi ${correction.revisionNo}, ${at}`,
  };
}

export interface SealedExportInput {
  po: PoRow;
  /** The PO's sealed submission, the newest item in the outbox. */
  item: OutboxRow;
  mapping: MappingIndex;
  /** The photo blobs stored with the submission (`outboxPhotos`). */
  photoBlobs: Pick<OutboxPhotoRow, 'defectId' | 'blob'>[];
}

/**
 * The session state a sealed submission describes, so the report figures come from the same `totals` as Home
 * (ADR-022 decision 7). Findings are expanded back into taps in their order, which `findings` groups again into
 * exactly the submitted findings; no inspection is active at SUBMIT PO.
 */
function stateOf(submission: SubmissionRequest): SessionState {
  const { counts } = submission;
  const tapped = counts.noDefect !== undefined;
  const recorded: RecordedDefect[] = submission.findings.flatMap((f) =>
    Array.from({ length: f.qty }, () => ({
      inspectionType: f.inspectionType,
      areaId: f.areaId,
      subAreaId: f.subAreaId,
      familyId: f.familyId,
      defectId: f.defectId,
      at: f.firstRecordedAt,
    })),
  );
  return {
    ...emptySession(tapped ? 'TAPPED' : 'ENTERED'),
    counts: { rework: counts.rework, bGrade: counts.bGrade },
    noDefect: counts.noDefect ?? 0,
    qtyInspection: counts.qtyInspection ?? null,
    reworkApproved: counts.reworkApproved ?? null,
    recorded,
  };
}

/** The report of a sealed submission (FR-12): only what was sent at SUBMIT PO. */
export function sealedExport({ po, item, mapping, photoBlobs }: SealedExportInput): ExportReport {
  const submission = JSON.parse(item.payloadJson) as SubmissionRequest;
  if (submission.po !== po.po)
    throw new Error(`Outbox item is for PO ${submission.po}, not ${po.po}`);
  return buildReport(submission, po, mapping, photoBlobs, null);
}

export interface CorrectedExportInput {
  correction: CorrectionRow;
  mapping: MappingIndex;
  /** The correction's own photos (`correctionPhotos`). */
  correctionPhotos: Pick<CorrectionPhotoRow, 'defectId' | 'blob' | 'sha256'>[];
  /** The sealed submission's photos; a kept photo is one of them, found by its SHA-256. */
  outboxPhotos: Pick<OutboxPhotoRow, 'defectId' | 'blob' | 'sha256'>[];
}

/**
 * The report of an admin correction (ADR-024, AC-12.5): the corrected figures, PO, PSI, Factory/Cell, findings,
 * photos and inspection date, with the revision named in the file.
 */
export function correctedExport({
  correction,
  mapping,
  correctionPhotos,
  outboxPhotos,
}: CorrectedExportInput): ExportReport {
  const c = correction.submission;
  const submission: SubmissionRequest = {
    submissionUuid: correction.submissionUuid,
    sealedAt: c.sealedAt,
    appVersion: '',
    user: c.user,
    factory: c.factory,
    cell: c.cell,
    po: c.po,
    partial: c.partial,
    counts:
      c.counts.noDefect !== undefined
        ? {
            rework: c.counts.rework,
            bGrade: c.counts.bGrade,
            reworkApproved: c.counts.reworkApproved,
            noDefect: c.counts.noDefect,
          }
        : {
            rework: c.counts.rework,
            bGrade: c.counts.bGrade,
            reworkApproved: c.counts.reworkApproved,
            qtyInspection: c.counts.qtyInspection ?? 0,
          },
    ...(c.photoRule === 'ALL' ? { photoRule: 'ALL' as const } : {}),
    findings: c.findings.map((f) => ({
      inspectionType: f.inspectionType,
      areaId: f.areaId,
      subAreaId: f.subAreaId,
      familyId: f.familyId,
      defectId: f.defectId,
      qty: f.qty,
      firstRecordedAt: f.firstRecordedAt,
    })),
    photos: correction.photos.map((p) => ({
      defectId: p.defectId,
      part: `photo_${p.defectId}`,
      sha256: p.sha256,
    })),
  };
  const bySha = new Map(
    [...outboxPhotos, ...correctionPhotos].map((p) => [p.sha256, p.blob] as const),
  );
  const blobs = correction.photos.flatMap((p) => {
    const blob = bySha.get(p.sha256);
    return blob ? [{ defectId: p.defectId, blob }] : [];
  });
  const po = {
    po: c.po,
    article: c.article,
    model: c.model,
    destination: c.destination,
    orderQty: c.orderQty,
  };
  return buildReport(submission, po, mapping, blobs, {
    revisionNo: correction.revisionNo,
    correctedAt: correction.correctedAt,
  });
}

function buildReport(
  submission: SubmissionRequest,
  po: Pick<PoRow, 'po' | 'article' | 'model' | 'destination' | 'orderQty'>,
  mapping: MappingIndex,
  photoBlobs: Pick<OutboxPhotoRow, 'defectId' | 'blob'>[],
  correction: ExportReport['correction'],
): ExportReport {
  const state = stateOf(submission);
  const blobOf = new Map(photoBlobs.map((p) => [p.defectId, p.blob]));
  // The partial in force at SUBMIT PO, not the PO's current one.
  const lot = { ...po, partial: submission.partial };

  const defectOf = (id: DefectId) => {
    const defect = mapping.defect(id);
    if (!defect) throw new Error(`Unknown defect ${id}`);
    return defect;
  };

  const list = findings(state);
  const ranked = rankDefects(list, (id) => defectOf(id).classification);
  const t = totals(state, lot);
  const count = (n: number | null) => n ?? 0;
  /**
   * A defect's share of QTY INSPECTION, only while QTY INSPECTION is valid: Defect Rate is null exactly when it is
   * empty, not valid (BR-10) or 0, and every figure that needs a valid QTY INSPECTION is then 0,0% (31 Oct 2026),
   * so the rows always agree with Defect Rate.
   */
  const share = (qty: number) =>
    t.defectRate === null || t.qtyInspection === null ? 0 : qty / t.qtyInspection;

  // AC-12.3: a sealed submission's inspection date is the WIB date of `sealedAt` (doc 02 §4.1). Export time never
  // enters.
  const date = inspectionDate(submission.sealedAt);
  const psiName = `${submission.user.username} (${submission.user.level})`;

  const info: Array<[string, string]> = [
    ['PO NUMBER', po.po],
    ['ARTIKEL', po.article],
    ['MODEL', po.model],
    ['DESTINATION', po.destination],
  ];
  if (submission.partial) info.push(['PARTIAL', formatPartial(submission.partial, po.orderQty)]);
  info.push(
    ['INSPEKTOR', psiName],
    ['FACTORY/CELL', submission.cell],
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
      const blob = blobOf.get(row.defectId);
      return blob
        ? [
            {
              defectId: row.defectId,
              name: defectOf(row.defectId).name,
              no: i + 1,
              blob,
            },
          ]
        : [];
    }),
    missingPhotos: takesPhotos(submission.user.level)
      ? missingPhotos(
          ranked,
          new Set(submission.photos.map((p) => p.defectId)),
          submission.photoRule ?? 'TOP5',
        ).map((row) => defectOf(row.defectId).name)
      : [],
    correction,
  };
}
