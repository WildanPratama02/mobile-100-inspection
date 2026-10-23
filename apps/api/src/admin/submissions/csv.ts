/**
 * The CSV export of the admin submission list (doc 04 §8, §10 A14, doc 02 §8): one row per submission with the
 * columns of `v_submissions` and the Top 5 as columns. UTF-8 with a BOM (so Excel reads the names right), `,`
 * between fields, CRLF between rows, RFC 4180 quoting. Numbers are raw: no thousands separator, a dot for decimals,
 * `rft` and `defect_rate` as the stored fractions (`0.60000`), so a spreadsheet or script reads them as numbers.
 */
import { type DefectId, formatDisplayNo, toWibIso } from '@m100/shared';
import type { SubmissionRow } from '../../repositories/submission-admin.repository';

export const CSV_BOM = '﻿';
export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

/** One Top 5 place: the defect and its quantity summed over areas and inspection types. */
export interface Top5Cell {
  defectId: DefectId;
  defectName: string;
  qty: number;
}

const TOP5_COLUMNS = [1, 2, 3, 4, 5].flatMap((n) => [
  `top${n}_defect_id`,
  `top${n}_defect_name`,
  `top${n}_qty`,
]);

export const EXPORT_COLUMNS: readonly string[] = [
  'display_no',
  'id',
  'inspection_date',
  'sealed_at',
  'username',
  'level',
  'factory',
  'cell',
  'po',
  'article',
  'model',
  'destination',
  'order_qty',
  'podd',
  'crd',
  'partial_no',
  'partial_qty',
  'partial_text',
  'qty_rework',
  'qty_bgrade_inspections',
  'qty_no_defect',
  'qty_inspection',
  'qty_a_grade',
  'qty_b_grade',
  'qty_defect',
  'rft',
  'defect_rate',
  'photo_count',
  'counting_rule',
  ...TOP5_COLUMNS,
];

type Cell = string | number | null;

/**
 * Text typed by people (names, PO fields, defect names) that a spreadsheet would run as a formula gets a leading
 * `'`, so opening the export never executes anything (CSV injection).
 */
export function safeText(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** One field: quoted when it holds `,`, `"`, CR or LF, with `"` doubled; `null` is an empty field. */
export function csvField(value: Cell): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One line, CRLF included. */
export function csvLine(cells: readonly Cell[]): string {
  return `${cells.map(csvField).join(',')}\r\n`;
}

/** The BOM and the header line: the start of every export, also of an empty one. */
export function csvHeader(): string {
  return CSV_BOM + csvLine(EXPORT_COLUMNS);
}

/** The cells of one submission, in the order of `EXPORT_COLUMNS`. */
export function exportCells(row: SubmissionRow, top5: readonly Top5Cell[]): Cell[] {
  const places = [0, 1, 2, 3, 4].flatMap((i) => {
    const place = top5[i];
    return place ? [place.defectId, safeText(place.defectName), place.qty] : [null, null, null];
  });
  return [
    formatDisplayNo(row.displayNo),
    row.id,
    row.inspectionDate,
    toWibIso(row.sealedAt),
    safeText(row.username),
    row.level,
    safeText(row.factory),
    safeText(row.cell),
    safeText(row.po),
    safeText(row.article),
    safeText(row.model),
    safeText(row.destination),
    row.orderQty,
    row.podd,
    row.crd,
    row.partialNo,
    row.partialQty,
    row.partialText,
    row.qtyRework,
    row.qtyBGradeInspections,
    row.qtyNoDefect,
    row.qtyInspection,
    row.qtyAGrade,
    row.qtyBGrade,
    row.qtyDefect,
    row.rft,
    row.defectRate,
    row.photoCount,
    row.countingRule,
    ...places,
  ];
}
