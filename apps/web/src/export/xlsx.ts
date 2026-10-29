/**
 * EXPORT EXCEL (FR-12): the report as an `.xlsx` with one sheet, Ringkasan (header, results, Top 5); there is no
 * full defect list (ADR-021). Quantities are numbers and rates are percentages, so the file can be calculated
 * with; a rate that can't be computed is "—" (BR-02).
 */
import writeXlsxFile, { type Cell, type Row, type SheetData } from 'write-excel-file/browser';
import { NO_VALUE } from '@m100/shared';
import { EXPORT_TITLE, NO_DEFECT_TEXT, type ExportReport } from './report';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const SUMMARY_SHEET = 'Ringkasan';

const bold = (value: string): Cell => ({ value, fontWeight: 'bold' });
const head = (labels: string[]): Row => labels.map(bold);

function summary(report: ExportReport): SheetData {
  const rows: SheetData = [[{ value: EXPORT_TITLE, fontWeight: 'bold', fontSize: 14 }], []];
  for (const [label, value] of report.info) rows.push([bold(label), value]);
  rows.push([], [bold('HASIL')]);
  for (const r of report.results) {
    rows.push([
      bold(r.label),
      r.value === null
        ? NO_VALUE
        : r.kind === 'count'
          ? { value: r.value, type: Number, format: '#,##0' }
          : { value: r.value, type: Number, format: '0.0%' },
    ]);
  }
  rows.push([], [bold('TOP 5 DEFECT')], head(['No', 'Defect', 'Klasifikasi', 'Area', 'Qty']));
  if (report.top5.length === 0) rows.push([null, NO_DEFECT_TEXT]);
  for (const t of report.top5) rows.push([t.no, t.name, t.classification, t.areas, t.qty]);
  return rows;
}

export async function toXlsx(report: ExportReport): Promise<Blob> {
  const blob = await writeXlsxFile([
    {
      sheet: SUMMARY_SHEET,
      data: summary(report),
      columns: [{ width: 18 }, { width: 60 }, { width: 13 }, { width: 28 }, { width: 8 }],
    },
  ]).toBlob();
  return new Blob([blob], { type: XLSX_TYPE });
}
