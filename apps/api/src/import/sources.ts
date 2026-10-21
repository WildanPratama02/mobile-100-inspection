/**
 * The input files of `import-master` (doc 02 §5.1): the four sheets of the old spreadsheet, either as one exported
 * workbook (`.xlsx`) or as four CSV files, and the mapping workbook. Reading only turns cells into values; every
 * rule about what a value means is in `parse-master.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import { readSheet } from 'read-excel-file/node';

/** A cell as read: CSV gives text only; a workbook gives numbers, booleans and dates (UTC midnight) too. */
export type CellValue = string | number | boolean | Date | null;

export interface TableRow {
  /** Row number in the sheet (1 is the header), for the report. */
  line: number;
  /** The required columns of the table, by header name. */
  cells: Readonly<Record<string, CellValue>>;
}

export interface Table {
  sheet: string;
  /** File name only, for the report and `pos.source`. */
  file: string;
  /** Rows with a value in at least one required column; blank rows and side tables are left out. */
  rows: TableRow[];
}

/** Sheets of the old spreadsheet and the columns the import reads from them. */
export const OLD_SHEETS = {
  USER_LIST: ['USERNAME', 'TYPE INSPECTION'],
  DB_CELL: ['FACTORY', 'CELL'],
  ALL_PO_MASTER: ['PO', 'ARTICLE', 'MODEL', 'DESTINATION', 'ORDER QTY', 'PODD', 'CRD'],
  DEFECT_LIST: ['CTQ DEFECT CODE', 'DEFECT CLASSIFICATION', 'DEFECT NAME', 'CLASSIFICATION'],
} as const;

/** Sheets of `Footwear_Defect_Mapping_Database_v2.xlsx` and the columns the import reads from them. */
export const MAPPING_SHEETS = {
  Area_Master: ['AREA_ID', 'AREA_NAME', 'DISPLAY_ORDER'],
  SubArea_Master: ['SUB_AREA_ID', 'AREA_ID', 'SUB_AREA_NAME', 'DISPLAY_ORDER'],
  Defect_Family: ['FAMILY_ID', 'FAMILY_NAME'],
  Defect_Master: ['DEFECT_ID', 'DEFECT_NAME', 'FAMILY_ID'],
  Defect_Area_Map: ['MAP_ID', 'DEFECT_ID', 'AREA_ID', 'SUB_AREA_ID'],
} as const;

export type OldSheet = keyof typeof OLD_SHEETS;
export type MappingSheet = keyof typeof MAPPING_SHEETS;
export type MasterTables = Record<OldSheet | MappingSheet, Table>;

export const MAPPING_FILE = 'Footwear_Defect_Mapping_Database_v2.xlsx';
const MAPPING_NAME = /^Footwear_Defect_Mapping.*\.xlsx$/i;

/** A file that is missing, ambiguous or unreadable; the import stops before it touches the database. */
export class SourceError extends Error {
  override name = 'SourceError';
}

export interface SourceFiles {
  /** One workbook holding the four old sheets, or one CSV file per sheet. */
  old: { kind: 'xlsx'; file: string } | { kind: 'csv'; files: Record<OldSheet, string> };
  mapping: string;
}

/**
 * Finds the input files in `dir`. A CSV counts for a sheet when its name is the sheet name, or ends with
 * ` - <sheet>` as Google Sheets names a downloaded tab. Without CSV files the folder must hold exactly one workbook
 * besides the mapping workbook; mixing the two forms is refused, so it is always clear which file was imported.
 * The mapping workbook is `mapping`, else the one in `dir`, else the copy in `reference/mapping/`.
 */
export function findSources(dir: string, mapping?: string): SourceFiles {
  const folder = resolve(dir);
  let names: string[];
  try {
    names = readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('~$'))
      .map((entry) => entry.name);
  } catch (error) {
    throw new SourceError(`Cannot read the folder ${folder}: ${(error as Error).message}`);
  }

  const mappingFiles = names.filter((name) => MAPPING_NAME.test(name));
  const workbooks = names.filter(
    (name) => extname(name).toLowerCase() === '.xlsx' && !MAPPING_NAME.test(name),
  );
  const csvs = names.filter((name) => extname(name).toLowerCase() === '.csv');

  let mappingFile: string;
  if (mapping) mappingFile = resolve(mapping);
  else if (mappingFiles.length > 1)
    throw new SourceError(
      `More than one mapping workbook in ${folder}: ${mappingFiles.join(', ')}`,
    );
  else if (mappingFiles[0]) mappingFile = join(folder, mappingFiles[0]);
  else mappingFile = findReferenceMapping();

  const csvFor = (sheet: OldSheet): string[] =>
    csvs.filter((name) => {
      const stem = basename(name, extname(name)).toUpperCase();
      return stem === sheet || stem.endsWith(` - ${sheet}`);
    });
  const matched = Object.keys(OLD_SHEETS).map(
    (sheet) => [sheet, csvFor(sheet as OldSheet)] as const,
  );

  if (matched.some(([, files]) => files.length > 0)) {
    if (workbooks.length > 0) {
      throw new SourceError(
        `${folder} holds both CSV files and a workbook (${workbooks.join(', ')}); keep one form only`,
      );
    }
    const files = {} as Record<OldSheet, string>;
    for (const [sheet, found] of matched) {
      if (found.length === 0) throw new SourceError(`No CSV file for ${sheet} in ${folder}`);
      if (found.length > 1)
        throw new SourceError(`More than one CSV file for ${sheet}: ${found.join(', ')}`);
      files[sheet as OldSheet] = join(folder, found[0]!);
    }
    return { old: { kind: 'csv', files }, mapping: mappingFile };
  }

  if (workbooks.length === 0) {
    throw new SourceError(
      `No master data in ${folder}: expected one .xlsx export or CSV files for ${Object.keys(OLD_SHEETS).join(', ')}`,
    );
  }
  if (workbooks.length > 1)
    throw new SourceError(`More than one workbook in ${folder}: ${workbooks.join(', ')}`);
  return { old: { kind: 'xlsx', file: join(folder, workbooks[0]!) }, mapping: mappingFile };
}

/** The mapping workbook in `reference/mapping/` of the nearest ancestor that has one (the repository root). */
export function findReferenceMapping(from: string = __dirname): string {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const candidate = join(dir, 'reference', 'mapping', MAPPING_FILE);
    if (readdirSafe(join(dir, 'reference', 'mapping')).includes(MAPPING_FILE)) return candidate;
    if (dirname(dir) === dir) {
      throw new SourceError(
        `No ${MAPPING_FILE}: pass --mapping or put it in the master data folder`,
      );
    }
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Reads every table the import needs. */
export async function readSources(sources: SourceFiles): Promise<MasterTables> {
  return { ...(await readOldSheets(sources.old)), ...(await readMapping(sources.mapping)) };
}

export async function readOldSheets(old: SourceFiles['old']): Promise<Record<OldSheet, Table>> {
  const tables = {} as Record<OldSheet, Table>;
  const buffer = old.kind === 'xlsx' ? readFile(old.file) : undefined;
  for (const [sheet, columns] of Object.entries(OLD_SHEETS)) {
    const name = sheet as OldSheet;
    tables[name] =
      old.kind === 'xlsx'
        ? toTable(sheet, old.file, await xlsxRows(buffer!, old.file, sheet), columns)
        : toTable(sheet, old.files[name], csvRows(old.files[name]), columns);
  }
  return tables;
}

export async function readMapping(file: string): Promise<Record<MappingSheet, Table>> {
  const tables = {} as Record<MappingSheet, Table>;
  const buffer = readFile(file);
  for (const [sheet, columns] of Object.entries(MAPPING_SHEETS)) {
    tables[sheet as MappingSheet] = toTable(
      sheet,
      file,
      await xlsxRows(buffer, file, sheet),
      columns,
    );
  }
  return tables;
}

function readFile(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch (error) {
    throw new SourceError(`Cannot read ${file}: ${(error as Error).message}`);
  }
}

async function xlsxRows(buffer: Buffer, file: string, sheet: string): Promise<CellValue[][]> {
  try {
    // trim: false, so text reaches the database exactly as it was in the sheet (doc 02 §3.3).
    return (await readSheet(buffer, sheet, { trim: false })) as CellValue[][];
  } catch (error) {
    throw new SourceError(
      `Cannot read sheet ${sheet} of ${basename(file)}: ${(error as Error).message}`,
    );
  }
}

function csvRows(file: string): CellValue[][] {
  try {
    const rows: string[][] = parseCsv(readFile(file), {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: false,
    });
    return rows.map((row) => row.map((value) => (value === '' ? null : value)));
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(`Cannot read ${basename(file)}: ${(error as Error).message}`);
  }
}

/**
 * A sheet's rows (the first is the header) as a `Table` of its required columns. Header names are compared without
 * surrounding spaces and case; values are kept as read.
 */
export function toTable(
  sheet: string,
  file: string,
  rows: CellValue[][],
  columns: readonly string[],
): Table {
  const header = (rows[0] ?? []).map((value) =>
    typeof value === 'string' ? value.trim().toUpperCase() : '',
  );
  const index = new Map<string, number>();
  for (const column of columns) {
    const found = header.flatMap((name, i) => (name === column.toUpperCase() ? [i] : []));
    if (found.length === 0)
      throw new SourceError(`${sheet} in ${basename(file)} has no column ${column}`);
    if (found.length > 1)
      throw new SourceError(`${sheet} in ${basename(file)} has the column ${column} twice`);
    index.set(column, found[0]!);
  }
  const table: Table = { sheet, file: basename(file), rows: [] };
  rows.slice(1).forEach((row, i) => {
    const cells = Object.fromEntries(columns.map((c) => [c, row[index.get(c)!] ?? null]));
    if (Object.values(cells).some((value) => !isBlank(value))) {
      table.rows.push({ line: i + 2, cells });
    }
  });
  return table;
}

export function isBlank(value: CellValue): boolean {
  return value === null || (typeof value === 'string' && value.trim() === '');
}
