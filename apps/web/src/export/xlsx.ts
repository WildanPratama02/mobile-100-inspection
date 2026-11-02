/**
 * EXPORT EXCEL (FR-12, doc 05 §8.5): the report as an `.xlsx` with one sheet, PSI Report, in the template's
 * layout (Part I, Part II, Part III and the Defect Findings List). Quantities are numbers and rates are
 * percentages, so the file can be calculated with; it holds values only, no formulas (ADR-022).
 */
import writeXlsxFile, { type Cell, type Row, type SheetData } from 'write-excel-file/browser';
import { APP_NAME, formatDate } from '@m100/shared';
import { NO_DEFECT_TEXT, type ExportReport, type ResultValue } from './report';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const SUMMARY_SHEET = 'PSI Report';

const bold = (value: string): Cell => ({ value, fontWeight: 'bold' });
const head = (labels: string[]): Row => labels.map(bold);

function valueCell(r: ResultValue): Cell {
  return r.kind === 'count'
    ? { value: r.value, type: Number, format: '#,##0' }
    : { value: r.value, type: Number, format: '0.0%' };
}

function summary(report: ExportReport): SheetData {
  const rows: SheetData = [
    [{ value: APP_NAME, fontWeight: 'bold', fontSize: 14 }],
    [],
    [bold('Part I: General Data')],
    [bold('Date'), formatDate(report.date)],
    [bold('PSI Name'), report.psiName],
    [],
    [bold('Part II: KPI Summary')],
  ];
  for (const r of report.kpi) rows.push([bold(r.label), valueCell(r)]);
  rows.push([], [bold('Part III: Daily Inspection Summary')]);
  for (const row of report.summary) {
    rows.push([
      bold(row.label),
      typeof row.value === 'number'
        ? { value: row.value, type: Number, format: '#,##0' }
        : row.value,
    ]);
  }
  rows.push(
    [],
    [bold('Defect Findings List')],
    head(['No', 'Defect', 'Severity', 'Qty', '% of QTY INSPECTION']),
  );
  if (report.defects.length === 0) {
    rows.push([null, NO_DEFECT_TEXT]);
  } else {
    for (const d of report.defects) {
      rows.push([
        d.no,
        d.name,
        d.classification,
        { value: d.qty, type: Number, format: '#,##0' },
        { value: d.rate, type: Number, format: '0.0%' },
      ]);
    }
  }
  return rows;
}

export async function toXlsx(report: ExportReport): Promise<Blob> {
  const blob = await writeXlsxFile([
    {
      sheet: SUMMARY_SHEET,
      data: summary(report),
      columns: [{ width: 40 }, { width: 42 }, { width: 13 }, { width: 10 }, { width: 22 }],
    },
  ]).toBlob();
  return new Blob([blob], { type: XLSX_TYPE });
}
