import { parse as parseCsv } from 'csv-parse/sync';
import { DeviceCommandError } from './device-admin';

/**
 * The labels of `device:add --batch tablets.csv` (doc 03 §7.5): a CSV in UTF-8 (a BOM, as Excel writes, is fine)
 * whose header has a `label` column, one tablet per row. Other columns and blank rows are ignored; labels are
 * trimmed. Duplicates are left in, so `addDevices` can name them.
 */
export function parseTabletsCsv(text: string | Buffer): string[] {
  let rows: string[][];
  try {
    rows = parseCsv(text, { bom: true, relax_column_count: true, skip_empty_lines: true });
  } catch (error) {
    throw new DeviceCommandError(`Cannot read the CSV: ${(error as Error).message}`);
  }
  const [header, ...body] = rows;
  const column = header?.findIndex((name) => name.trim().toLowerCase() === 'label') ?? -1;
  if (column < 0) throw new DeviceCommandError('The CSV has no "label" column in its first row');
  const labels = body.map((row) => (row[column] ?? '').trim()).filter((label) => label !== '');
  if (labels.length === 0) throw new DeviceCommandError('The CSV has no labels');
  return labels;
}
