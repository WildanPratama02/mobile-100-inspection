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

/** D005, one of the longest names in the mapping: its caption needs more than two lines. */
export const ODD_PAIR =
  'ODD PAIR (BOTH LEFT/RIGHT SHOES IN PAIR, DIFFERENT SIZE IN ONE PAIR, SHOE SIZE NOT AS LABEL/STICKER)';

/** The name D049 and D071 share in the mapping (ADR-009). */
export const SHARED_NAME = 'POOR TOUCH UP/PAINTING, MARKING LINE';

export const REPORT: ExportReport = {
  fileBase: 'PSI_0903359388_20261019',
  date: '2026-10-19',
  psiName: 'DEWI CONTOH (PSI lv.2)',
  info: [
    ['PO NUMBER', '0903359388'],
    ['ARTIKEL', 'IH0001'],
    ['MODEL', 'RUNNER CONTOH 1'],
    ['DESTINATION', 'JAPAN'],
    ['PARTIAL', 'P1 · 1.200 dari 10.002'],
    ['INSPEKTOR', 'DEWI CONTOH (PSI lv.2)'],
    ['FACTORY/CELL', 'F3-10'],
    ['DATE INSPECTION', '19 Okt 2026'],
  ],
  results: [
    { label: 'Qty PO Order', kind: 'count', value: 10002 },
    { label: 'Qty Inspection', kind: 'count', value: 30 },
    { label: 'INSPECTION REWORK QTY', kind: 'count', value: 1 },
    { label: 'Qty Defect', kind: 'count', value: 7 },
    { label: 'Qty A-Grade', kind: 'count', value: 23 },
    { label: 'Qty B-Grade', kind: 'count', value: 1 },
    { label: 'REWORK AND APPROVED', kind: 'count', value: 1 },
    { label: 'Defect Rate', kind: 'rate', value: 7 / 30 },
    { label: 'Pass Rate (RFT)', kind: 'rate', value: 23 / 30 },
  ],
  kpi: [
    { label: 'Inspected Qty', kind: 'count', value: 30 },
    { label: 'Inspected Qty (Including Rework)', kind: 'count', value: 31 },
    { label: 'Rejected Order Qty', kind: 'count', value: 7 },
    { label: 'RFT %', kind: 'rate', value: 23 / 30 },
    { label: 'Defect %', kind: 'rate', value: 7 / 30 },
    { label: 'Not Reworkable Defect Qty', kind: 'count', value: 1 },
    { label: 'Not Reworkable Defect %', kind: 'rate', value: 1 / 30 },
    { label: 'Total Approved Qty', kind: 'count', value: 24 },
  ],
  summary: [
    { label: 'PO NO', value: '0903359388' },
    { label: 'Model Name', value: 'RUNNER CONTOH 1' },
    { label: 'Qty Order', value: 10002 },
    { label: 'Destination', value: 'JAPAN' },
    { label: 'Offered Lot Qty', value: 1200 },
    { label: 'Inspected Qty', value: 30 },
    { label: 'Inspected Qty (Including Rework)', value: 31 },
    { label: 'Approved Qty', value: 23 },
    { label: 'Rejected Qty', value: 7 },
    { label: 'Rework and Approved', value: 1 },
    { label: 'Pairs Not Reworkable & Not Shippable (B&C Grade)', value: 1 },
    { label: 'Balance Rework', value: 0 },
    { label: 'Balance Qty', value: 1170 },
  ],
  // Names and severities exactly as in the mapping, in rankDefects order (quantity, then CRITICAL > MAJOR > MINOR,
  // then first recorded). D049 and D071 share a name (ADR-009): two rows and two photos, told apart by DEFECT_ID.
  defects: [
    {
      no: 1,
      defectId: 'D005',
      name: ODD_PAIR,
      classification: 'CRITICAL',
      areas: 'VAMP, TOE BOX',
      qty: 2,
      rate: 2 / 30,
    },
    {
      no: 2,
      defectId: 'D035',
      name: 'BROKEN STITCHING/LOOSE STITCHING/SKIPPED STITCHING/OPEN SEAM',
      classification: 'MAJOR',
      areas: 'QUARTER',
      qty: 1,
      rate: 1 / 30,
    },
    {
      no: 3,
      defectId: 'D082',
      name: 'BONDING GAP (>4mm)',
      classification: 'MAJOR',
      areas: 'TOE BOX',
      qty: 1,
      rate: 1 / 30,
    },
    {
      no: 4,
      defectId: 'D077',
      name: 'COMPONENTS DELAMINATION (>4mm length and depth)',
      classification: 'MAJOR',
      areas: 'OUTSOLE',
      qty: 1,
      rate: 1 / 30,
    },
    {
      no: 5,
      defectId: 'D049',
      name: SHARED_NAME,
      classification: 'MINOR',
      areas: 'MEDIAL QUARTER',
      qty: 1,
      rate: 1 / 30,
    },
    {
      no: 6,
      defectId: 'D071',
      name: SHARED_NAME,
      classification: 'MINOR',
      areas: 'MEDIAL QUARTER',
      qty: 1,
      rate: 1 / 30,
    },
  ],
  photos: [
    { defectId: 'D005', name: ODD_PAIR, no: 1, blob: new Blob([JPEG]) },
    {
      defectId: 'D035',
      name: 'BROKEN STITCHING/LOOSE STITCHING/SKIPPED STITCHING/OPEN SEAM',
      no: 2,
      blob: new Blob([JPEG]),
    },
    { defectId: 'D049', name: SHARED_NAME, no: 5, blob: new Blob([JPEG]) },
    { defectId: 'D071', name: SHARED_NAME, no: 6, blob: new Blob([JPEG]) },
  ],
  missingPhotos: [],
};

/** The same session for PSI lv.1: no photos. */
export const REPORT_LV1: ExportReport = {
  ...REPORT,
  psiName: 'ANDI CONTOH (PSI lv.1)',
  photos: [],
};

/** An empty session: every figure `0`, no defect (doc 05 §8.5). */
export const REPORT_EMPTY: ExportReport = {
  ...REPORT_LV1,
  info: REPORT.info.slice(0, 7),
  results: REPORT.results.map((r) => ({
    ...r,
    value: r.label === 'Qty PO Order' ? r.value : 0,
  })),
  kpi: REPORT.kpi.map((r) => ({ ...r, value: 0 })),
  summary: REPORT.summary.map((row) =>
    typeof row.value === 'number' && row.label !== 'Qty Order' ? { ...row, value: 0 } : row,
  ),
  defects: [],
};
