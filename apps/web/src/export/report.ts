/**
 * What EXPORT PDF and EXPORT EXCEL put in their files (FR-12, AC-12.1, doc 05 §8.5), derived from the selected
 * PO's open session with `@m100/shared`. Both files are drawn from this one model, so they never disagree, and
 * building it only reads: the session, its photos and Dexie stay as they were (AC-12.4).
 */
import {
  APP_NAME,
  countingMode,
  emptySession,
  fileDate,
  findings,
  formatDateTime,
  formatPartial,
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

/** Shown in place of the Top 5 of an empty session (doc 05 §8.5). */
export const NO_DEFECT_TEXT = 'Belum ada defect.';

export type ResultValue =
  /** `null` for a Qty Inspection not entered yet, or Qty A-Grade while it is not valid (BR-02). */
  | { label: string; kind: 'count'; value: number | null }
  /** `null` while Qty Inspection is empty or not valid (BR-02). */
  | { label: string; kind: 'rate'; value: number | null };

export interface Top5Line {
  no: number;
  defectId: DefectId;
  name: string;
  classification: Classification;
  areas: string;
  qty: number;
}

export interface ExportPhoto {
  defectId: DefectId;
  name: string;
  /** Its row in TOP 5 DEFECT, or `null` for a defect outside the Top 5 (AC-10.4). */
  top5No: number | null;
  blob: Blob;
}

export interface ExportReport {
  /** `M100_<PO>_<YYYYMMDD>`, without the extension (AC-12.3). */
  fileBase: string;
  /** Labelled values of the header: PO info, inspector, Factory/Cell, export time. */
  info: Array<[label: string, value: string]>;
  results: ResultValue[];
  /** Without a photo column; the files have no full defect list (ADR-021). */
  top5: Top5Line[];
  /** Every photo of a defect in the current findings, Top 5 first, each once (AC-12.2). */
  photos: ExportPhoto[];
  /** PSI lv.2: Top 5 defect names without a photo. Exporting is refused while any is left (BR-04). */
  missingPhotos: string[];
}

export interface ExportInput {
  po: PoRow;
  session: PoSession | undefined;
  auth: Auth;
  mapping: MappingIndex;
  now: Date;
}

export function exportReport({ po, session, auth, mapping, now }: ExportInput): ExportReport {
  const state = session?.state ?? emptySession(countingMode(auth.level));
  const attached = session?.photos ?? {};
  const photos = takesPhotos(auth.level);

  const defectOf = (id: DefectId) => {
    const defect = mapping.defect(id);
    if (!defect) throw new Error(`Unknown defect ${id}`);
    return defect;
  };

  const list = findings(state);
  // Ranked by the rules of TOP 5 DEFECT (AC-05.1); the first five are exactly what Home shows.
  const ranked = rankDefects(list, (id) => defectOf(id).classification);
  const top = ranked.slice(0, 5);
  const t = totals(state, po);

  const info: Array<[string, string]> = [
    ['PO NUMBER', po.po],
    ['ARTIKEL', po.article],
    ['MODEL', po.model],
    ['DESTINATION', po.destination],
  ];
  if (po.partial) info.push(['PARTIAL', formatPartial(po.partial, po.orderQty)]);
  info.push(
    ['INSPEKTOR', `${auth.username} (${auth.level})`],
    ['FACTORY/CELL', auth.cell],
    ['DICETAK', formatDateTime(now)],
  );

  return {
    fileBase: `M100_${po.po}_${fileDate(now)}`,
    info,
    results: [
      { label: 'Qty PO Order', kind: 'count', value: po.orderQty },
      { label: 'Qty Inspection', kind: 'count', value: t.qtyInspection },
      { label: 'Qty Defect', kind: 'count', value: t.qtyDefect },
      { label: 'Qty A-Grade', kind: 'count', value: t.qtyAGrade ?? 0 },
      { label: 'Qty B-Grade', kind: 'count', value: t.qtyBGrade },
      { label: 'Defect Rate', kind: 'rate', value: t.defectRate ?? 0 },
      { label: 'Pass Rate (RFT)', kind: 'rate', value: t.passRate ?? 0 },
    ],
    top5: top.map((row, i) => ({
      no: i + 1,
      defectId: row.defectId,
      name: defectOf(row.defectId).name,
      classification: row.classification,
      areas: areaLabels(row.areaIds, mapping),
      qty: row.qty,
    })),
    // A photo of a defect that was undone completely is not part of the findings and stays out.
    photos: ranked.flatMap((row, i) => {
      const photo = attached[row.defectId];
      return photo
        ? [
            {
              defectId: row.defectId,
              name: defectOf(row.defectId).name,
              top5No: i < 5 ? i + 1 : null,
              blob: photo.blob,
            },
          ]
        : [];
    }),
    missingPhotos: photos
      ? missingPhotos(top, new Set(Object.keys(attached) as DefectId[])).map(
          (row) => defectOf(row.defectId).name,
        )
      : [],
  };
}
