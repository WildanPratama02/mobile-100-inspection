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

/** Thin table borders like the reference template (reference/excel-format/excel-template.xlsx). */
const BORDER = { borderStyle: 'thin', borderColor: '#000000' } as const;

/** A bordered table cell; the title row stays without borders. */
const cell = (value: string | number | null): Cell => ({ value: value ?? undefined, ...BORDER });
const bold = (value: string): Cell => ({ value, fontWeight: 'bold', ...BORDER });
/** A bold cell on the light-gray fill of the template: the part headings and the table header row. */
const filled = (value: string): Cell => ({
  value,
  fontWeight: 'bold',
  backgroundColor: '#D9D9D9',
  ...BORDER,
});
const head = (labels: string[]): Row => labels.map(filled);
const count = (value: number): Cell => ({ value, type: Number, format: '#,##0', ...BORDER });
const rate = (value: number): Cell => ({ value, type: Number, format: '0.0%', ...BORDER });

function valueCell(r: ResultValue): Cell {
  return r.kind === 'count' ? count(r.value) : rate(r.value);
}

function summary(report: ExportReport): SheetData {
  const rows: SheetData = [
    [{ value: APP_NAME, fontWeight: 'bold', fontSize: 14 }],
    [],
    [filled('Part I: General Data')],
    [bold('Date'), cell(formatDate(report.date))],
    [bold('PSI Name'), cell(report.psiName)],
    [],
    [filled('Part II: KPI Summary')],
  ];
  for (const r of report.kpi) rows.push([bold(r.label), valueCell(r)]);
  rows.push([], [filled('Part III: Daily Inspection Summary')]);
  for (const row of report.summary) {
    rows.push([
      bold(row.label),
      typeof row.value === 'number' ? count(row.value) : cell(row.value),
    ]);
  }
  rows.push(
    [],
    [filled('Defect Findings List')],
    head(['No', 'Defect', 'Severity', 'Qty', '% of QTY INSPECTION']),
  );
  if (report.defects.length === 0) {
    rows.push([cell(null), cell(NO_DEFECT_TEXT), cell(null), cell(null), cell(null)]);
  } else {
    for (const d of report.defects) {
      rows.push([cell(d.no), cell(d.name), cell(d.classification), count(d.qty), rate(d.rate)]);
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
