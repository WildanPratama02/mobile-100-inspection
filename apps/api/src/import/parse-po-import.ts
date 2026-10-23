/**
 * The admin PO import (doc 04 §8, doc 05 §20.5): a CSV or workbook with the `ALL_PO_MASTER` columns, upserted by
 * `po`. Stricter than the one-time import (doc 02 §5.1), because an admin import with any invalid row applies nothing
 * (AC-14.3, decision A9 of doc 04 §10): every row the one-time import would skip is an error here, and so is a PODD or
 * CRD that is not a date. Rows of one PO that agree in every column are one PO; rows that disagree are all errors.
 * Text is kept exactly as in the file (doc 02 §3.3).
 */
import type { PoInput } from '../repositories/po.repository';
import { parseDate, positiveInteger, text } from './parse-master';
import { type CellValue, isBlank, type Table } from './sources';

export const PO_IMPORT_SHEET = 'ALL_PO_MASTER';
export const PO_IMPORT_COLUMNS = [
  'PO',
  'ARTICLE',
  'MODEL',
  'DESTINATION',
  'ORDER QTY',
  'PODD',
  'CRD',
] as const;

export type PoImportErrorCode = 'PO_EMPTY' | 'ORDER_QTY_INVALID' | 'DATE_INVALID' | 'PO_CONFLICT';

export interface PoImportError {
  /** Row number in the file (1 is the header). */
  line: number;
  code: PoImportErrorCode;
  /** Indonesian, shown in the import report as is. */
  message: string;
}

export interface ParsedPoImport {
  /** Rows with a value in any column. */
  read: number;
  /** Rows dropped because an earlier row of the same PO had the same values. */
  duplicatesMerged: number;
  /** The POs to upsert; complete only when `errors` is empty. */
  rows: PoInput[];
  /** By row. */
  errors: PoImportError[];
}

const COMPARED = ['ARTICLE', 'MODEL', 'DESTINATION', 'ORDER QTY', 'PODD', 'CRD'] as const;

interface Row {
  line: number;
  po: string;
  values: Record<(typeof COMPARED)[number], string | number | null>;
  valid: boolean;
}

export function parsePoImport(table: Table): ParsedPoImport {
  const errors: PoImportError[] = [];
  const error = (line: number, code: PoImportErrorCode, message: string) =>
    errors.push({ line, code, message });

  const groups = new Map<string, Row[]>();
  for (const { line, cells } of table.rows) {
    if (isBlank(cells.PO!)) {
      error(line, 'PO_EMPTY', 'Kolom PO kosong.');
      continue;
    }
    const po = text(cells.PO!);
    let valid = true;
    const orderQty = positiveInteger(cells['ORDER QTY']!);
    if (orderQty === null) {
      valid = false;
      error(
        line,
        'ORDER_QTY_INVALID',
        `PO ${po}: ORDER QTY "${text(cells['ORDER QTY']!)}" bukan bilangan bulat ≥ 1.`,
      );
    }
    const date = (column: 'PODD' | 'CRD'): string | null => {
      const value: CellValue = cells[column]!;
      const parsed = parseDate(value);
      if (parsed === null && !isBlank(value)) {
        valid = false;
        error(
          line,
          'DATE_INVALID',
          `PO ${po}: ${column} "${text(value)}" bukan tanggal (YYYY-MM-DD).`,
        );
      }
      return parsed;
    };
    const [podd, crd] = [date('PODD'), date('CRD')];
    const row: Row = {
      line,
      po,
      valid,
      values: {
        ARTICLE: text(cells.ARTICLE!),
        MODEL: text(cells.MODEL!),
        DESTINATION: text(cells.DESTINATION!),
        // An unusable quantity still takes part in the comparison, as its text.
        'ORDER QTY': orderQty ?? `invalid:${text(cells['ORDER QTY']!)}`,
        PODD: podd,
        CRD: crd,
      },
    };
    const group = groups.get(po);
    if (group) group.push(row);
    else groups.set(po, [row]);
  }

  const rows: PoInput[] = [];
  let duplicatesMerged = 0;
  for (const [po, group] of groups) {
    const first = group[0]!;
    const differ = COMPARED.filter((c) => group.some((r) => r.values[c] !== first.values[c]));
    if (differ.length > 0) {
      const lines = group.map((r) => r.line).join(', ');
      for (const row of group) {
        error(
          row.line,
          'PO_CONFLICT',
          `PO ${po} ada di baris ${lines} dengan nilai berbeda (${differ.join(', ')}).`,
        );
      }
      continue;
    }
    if (!first.valid) continue;
    duplicatesMerged += group.length - 1;
    rows.push({
      po,
      article: first.values.ARTICLE as string,
      model: first.values.MODEL as string,
      destination: first.values.DESTINATION as string,
      orderQty: first.values['ORDER QTY'] as number,
      podd: first.values.PODD as string | null,
      crd: first.values.CRD as string | null,
      // Not imported until PRD OQ-06 is decided (doc 02 §3.3).
      finished: null,
    });
  }
  errors.sort((a, b) => a.line - b.line);
  return { read: table.rows.length, duplicatesMerged, rows, errors };
}
