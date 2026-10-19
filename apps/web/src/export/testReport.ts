// Test data shared by the writer tests: one report as `exportReport` builds it, and image bytes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ExportReport } from './report';

/** The company mark as stored in the app (Vitest runs from `apps/web`). */
export const LOGO = new Uint8Array(
  readFileSync(path.join(process.cwd(), 'src', 'assets', 'parkland.png')),
);

/** A 1 × 1 JPEG, enough for jsPDF to read its size. */
export const JPEG = Uint8Array.from(
  atob(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  ),
  (c) => c.charCodeAt(0),
);

export const REPORT: ExportReport = {
  fileBase: 'M100_0903359388_20261019',
  info: [
    ['PO NUMBER', '0903359388'],
    ['ARTIKEL', 'IH0001'],
    ['MODEL', 'RUNNER CONTOH 1'],
    ['DESTINATION', 'JAPAN'],
    ['PARTIAL', 'P1 · 1.200 dari 10.002'],
    ['INSPEKTOR', 'DEWI CONTOH (PSI lv.2)'],
    ['FACTORY/CELL', 'F3-10'],
    ['DICETAK', '19 Okt 2026 14.05 WIB'],
  ],
  results: [
    { label: 'Qty PO Order', kind: 'count', value: 10002 },
    { label: 'Qty Inspection', kind: 'count', value: 16 },
    { label: 'Qty Defect', kind: 'count', value: 3 },
    { label: 'Qty A-Grade', kind: 'count', value: 13 },
    { label: 'Qty B-Grade', kind: 'count', value: 1 },
    { label: 'Defect Rate', kind: 'rate', value: 3 / 16 },
    { label: 'Pass Rate (RFT)', kind: 'rate', value: 13 / 16 },
  ],
  top5: [
    {
      no: 1,
      defectId: 'D005',
      name: 'BOND GAP',
      classification: 'CRITICAL',
      areas: 'VAMP, TOE BOX',
      qty: 2,
      photo: true,
    },
    {
      no: 2,
      defectId: 'D035',
      name: 'WRINKLE',
      classification: 'MAJOR',
      areas: 'QUARTER',
      qty: 1,
      photo: true,
    },
  ],
  defects: [
    {
      no: 1,
      inspectionType: 'REWORK',
      area: 'Vamp',
      subArea: 'Vamp Center',
      family: 'Bonding',
      defectId: 'D005',
      name: 'BOND GAP',
      classification: 'CRITICAL',
      qty: 2,
    },
    {
      no: 2,
      inspectionType: 'B-GRADE',
      area: 'Quarter',
      subArea: 'Medial Quarter',
      family: 'Upper Material',
      defectId: 'D035',
      name: 'WRINKLE',
      classification: 'MAJOR',
      qty: 1,
    },
  ],
  photos: [
    { defectId: 'D005', name: 'BOND GAP', top5No: 1, blob: new Blob([JPEG]) },
    { defectId: 'D035', name: 'WRINKLE', top5No: 2, blob: new Blob([JPEG]) },
    { defectId: 'D077', name: 'STAIN OUTSIDE', top5No: null, blob: new Blob([JPEG]) },
  ],
  missingPhotos: [],
};

/** The same session for PSI lv.1: no photo column, no photos. */
export const REPORT_LV1: ExportReport = {
  ...REPORT,
  top5: REPORT.top5.map((t) => ({ ...t, photo: null })),
  photos: [],
};

/** An empty session (doc 05 §8.5). */
export const REPORT_EMPTY: ExportReport = {
  ...REPORT_LV1,
  results: REPORT.results.map((r) =>
    r.kind === 'rate'
      ? { ...r, value: null }
      : { ...r, value: r.label === 'Qty PO Order' ? r.value : 0 },
  ),
  top5: [],
  defects: [],
};
