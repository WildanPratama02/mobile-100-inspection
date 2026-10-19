/**
 * EXPORT EXCEL (FR-12): the report as an `.xlsx` with two sheets, Ringkasan (header, results, Top 5) and
 * Daftar Defect (every finding). Quantities are numbers and rates are percentages, so the file can be
 * calculated with; a rate that can't be computed is "—" (BR-02).
 */
import writeXlsxFile, { type Cell, type Row, type SheetData } from 'write-excel-file/browser';
import { NO_VALUE } from '@m100/shared';
import { EXPORT_TITLE, NO_DEFECT_TEXT, type ExportReport } from './report';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const SUMMARY_SHEET = 'Ringkasan';
export const DEFECTS_SHEET = 'Daftar Defect';

const bold = (value: string): Cell => ({ value, fontWeight: 'bold' });
const head = (labels: string[]): Row => labels.map(bold);

function summary(report: ExportReport): SheetData {
  const photos = report.top5.some((row) => row.photo !== null);
  const rows: SheetData = [[{ value: EXPORT_TITLE, fontWeight: 'bold', fontSize: 14 }], []];
  for (const [label, value] of report.info) rows.push([bold(label), value]);
  rows.push([], [bold('HASIL')]);
  for (const r of report.results) {
    rows.push([
      bold(r.label),
      r.kind === 'count'
        ? { value: r.value, type: Number, format: '#,##0' }
        : r.value === null
          ? NO_VALUE
          : { value: r.value, type: Number, format: '0.0%' },
    ]);
  }
  rows.push(
    [],
    [bold('TOP 5 DEFECT')],
    head(['No', 'Defect', 'Klasifikasi', 'Area', 'Qty', ...(photos ? ['Foto'] : [])]),
  );
  if (report.top5.length === 0) rows.push([null, NO_DEFECT_TEXT]);
  for (const t of report.top5) {
    rows.push([
      t.no,
      t.name,
      t.classification,
      t.areas,
      t.qty,
      ...(photos ? [t.photo ? 'Ada' : '-'] : []),
    ]);
  }
  return rows;
}

function defects(report: ExportReport): SheetData {
  const rows: SheetData = [
    head(['No', 'Tipe Inspeksi', 'Area', 'Sub Area', 'Family', 'Defect', 'Klasifikasi', 'Qty']),
  ];
  if (report.defects.length === 0) rows.push([null, NO_DEFECT_TEXT]);
  for (const d of report.defects) {
    rows.push([
      d.no,
      d.inspectionType,
      d.area,
      d.subArea,
      d.family,
      d.name,
      d.classification,
      d.qty,
    ]);
  }
  return rows;
}

export async function toXlsx(report: ExportReport): Promise<Blob> {
  const blob = await writeXlsxFile([
    {
      sheet: SUMMARY_SHEET,
      data: summary(report),
      columns: [
        { width: 18 },
        { width: 60 },
        { width: 13 },
        { width: 28 },
        { width: 8 },
        { width: 8 },
      ],
    },
    {
      sheet: DEFECTS_SHEET,
      data: defects(report),
      columns: [
        { width: 5 },
        { width: 14 },
        { width: 18 },
        { width: 26 },
        { width: 26 },
        { width: 60 },
        { width: 13 },
        { width: 8 },
      ],
      stickyRowsCount: 1,
    },
  ]).toBlob();
  return new Blob([blob], { type: XLSX_TYPE });
}
