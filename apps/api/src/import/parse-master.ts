/**
 * The rules of `import-master` (doc 02 §3, §5.1), as a pure function from the read tables to the rows the
 * repositories upsert, plus a report. Two kinds of bad input are told apart:
 *
 * - **Invalid** data stops the whole import before anything is written (`ImportInvalid`): a missing sheet or
 *   column, `DEFECT_LIST` without exactly 98 rows, an unknown severity, a PSI row without a name, a cell under two
 *   factories, a mapping row that points nowhere, a workbook defect name that differs from `DEFECT_LIST`.
 * - **Skipped** PO rows are reported and left out, the rest is imported: an empty `PO`, an `ORDER QTY` that is not a
 *   whole number ≥ 1 (doc 02 §5.1), and every row of a PO number whose rows disagree (decided 21 Oct 2026). Rows of
 *   one PO that agree in every imported column are one PO. Conflicts are found over the whole sheet before anything
 *   is written, so no copy of a conflicting PO is ever imported.
 */
import {
  loginFactories,
  loginUsers,
  type Classification,
  type DefectId,
  type Family,
  type User,
} from '@m100/shared';
import type { PoInput } from '../repositories/po.repository';
import type {
  AreaInput,
  AreaMapInput,
  CellInput,
  DefectInput,
  SubAreaInput,
} from '../repositories/master-data.repository';
import { type CellValue, isBlank, type MasterTables, type Table, type TableRow } from './sources';

export interface ImportProblem {
  sheet: string;
  /** Sheet row number; absent for a problem of the whole sheet. */
  line?: number;
  message: string;
}

/** Invalid input: nothing may be written. */
export class ImportInvalid extends Error {
  override name = 'ImportInvalid';
  constructor(readonly problems: readonly ImportProblem[]) {
    super(`The master data is invalid (${problems.length} problems); nothing was written`);
  }
}

export type PoSkipReason = 'PO_EMPTY' | 'ORDER_QTY_INVALID' | 'PO_CONFLICT';

export interface PoConflict {
  po: string;
  lines: number[];
  /** Imported columns whose values differ between the rows. */
  columns: string[];
}

export interface SourceReport {
  users: { rows: number; psiRows: number; otherTypeRows: number; unique: number };
  cells: { rows: number; imported: number; factories: string[]; otherFactories: string[] };
  defects: { rows: number };
  mapping: {
    areas: number;
    subAreas: number;
    families: number;
    mapRows: number;
    /** Defects of `DEFECT_LIST` that no map row offers (a warning, doc 02 §3.5). */
    unmappedDefects: string[];
  };
  pos: {
    /** `ALL_PO_MASTER` rows with a value in any imported column. */
    rows: number;
    /** Rows dropped because an earlier row of the same PO had the same values. */
    duplicatesMerged: number;
    conflictGroups: number;
    conflictRows: number;
    /** Rows skipped for an empty PO or an unusable ORDER QTY. */
    otherSkippedRows: number;
    /** Distinct POs that will be upserted. */
    unique: number;
    /** Non-empty PODD or CRD cells that are not a date; stored as null (doc 02 §3.3). */
    unreadableDates: number;
    conflicts: PoConflict[];
    skipped: { line: number; po: string; reason: Exclude<PoSkipReason, 'PO_CONFLICT'> }[];
  };
}

export interface ParsedMaster {
  users: User[];
  factories: string[];
  cells: CellInput[];
  defects: DefectInput[];
  areas: AreaInput[];
  subAreas: SubAreaInput[];
  families: Family[];
  areaMap: AreaMapInput[];
  pos: PoInput[];
  /** `pos.source` of the imported rows: `import:<file>`. */
  poSource: string;
  report: SourceReport;
}

/** Row r (2–99) of `DEFECT_LIST` is `D(r−1)` (doc 02 §3.4, ADR-009). */
export const DEFECT_COUNT = 98;
const AREA_IDS = Array.from({ length: 12 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`);
const SEVERITIES: readonly string[] = ['MINOR', 'MAJOR', 'CRITICAL'] satisfies Classification[];
const PSI_TYPES: readonly string[] = ['PSI lv.1', 'PSI lv.2'];
/** The columns two rows of one PO must agree in to count as the same PO. */
const PO_COLUMNS = ['ARTICLE', 'MODEL', 'DESTINATION', 'ORDER QTY', 'PODD', 'CRD'] as const;

export function parseMaster(tables: MasterTables): ParsedMaster {
  const problems: ImportProblem[] = [];
  const problem = (table: Table, message: string, line?: number) =>
    problems.push({ sheet: table.sheet, ...(line === undefined ? {} : { line }), message });

  const users = parseUsers(tables.USER_LIST, problem);
  const cells = parseCells(tables.DB_CELL, problem);
  const defects = parseDefects(tables.DEFECT_LIST, problem);
  const mapping = parseMapping(tables, defects.rows, problem);
  const pos = parsePos(tables.ALL_PO_MASTER);

  if (problems.length > 0) throw new ImportInvalid(problems);
  return {
    users: users.rows,
    factories: cells.factories,
    cells: cells.rows,
    defects: defects.rows,
    areas: mapping.areas,
    subAreas: mapping.subAreas,
    families: mapping.families,
    areaMap: mapping.areaMap,
    pos: pos.rows,
    poSource: `import:${tables.ALL_PO_MASTER.file}`,
    report: {
      users: users.report,
      cells: cells.report,
      defects: { rows: defects.rows.length },
      mapping: mapping.report,
      pos: pos.report,
    },
  };
}

type Problem = (table: Table, message: string, line?: number) => void;

/** Text as it was in the sheet; a number from a workbook becomes its plain digits. */
function text(value: CellValue): string {
  if (value === null) return '';
  if (value instanceof Date) return isoDate(value);
  return String(value);
}

function optionalText(value: CellValue): string | null {
  return isBlank(value) ? null : text(value);
}

/** Ids and enum values are compared without surrounding spaces. */
function key(value: CellValue): string {
  return text(value).trim();
}

/** A whole number ≥ 1, from a number cell or from text holding digits only. */
function positiveInteger(value: CellValue): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*\d+\s*$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A workbook date (UTC midnight) or ISO text `2026-01-12` (optionally with a time); anything else is null. */
function parseDate(value: CellValue): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : isoDate(value);
  if (typeof value !== 'string') return null;
  const match = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[T ][0-9:.]+Z?)?\s*$/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return isoDate(date) === `${y}-${m}-${d}` ? isoDate(date) : null;
}

function parseUsers(table: Table, problem: Problem) {
  let psiRows = 0;
  const rows: { username: string; typeInspection: string }[] = [];
  for (const { line, cells } of table.rows) {
    const type = key(cells['TYPE INSPECTION']!);
    if (!PSI_TYPES.includes(type)) continue;
    psiRows++;
    if (isBlank(cells.USERNAME!)) problem(table, `${type} row without USERNAME`, line);
    else rows.push({ username: text(cells.USERNAME!), typeInspection: type });
  }
  const unique = loginUsers(rows);
  return {
    rows: unique,
    report: {
      rows: table.rows.length,
      psiRows,
      otherTypeRows: table.rows.length - psiRows,
      unique: unique.length,
    },
  };
}

function parseCells(table: Table, problem: Problem) {
  const all = table.rows.map(({ line, cells }) => ({
    line,
    factory: key(cells.FACTORY!),
    cell: key(cells.CELL!),
  }));
  const imported = loginFactories(all);
  const keep = new Set(imported.map((f) => f.factory));
  const factoryOf = new Map<string, string>();
  for (const { line, factory, cell } of all) {
    if (!keep.has(factory)) continue;
    if (cell === '') {
      problem(table, `Factory ${factory} row without CELL`, line);
      continue;
    }
    const earlier = factoryOf.get(cell);
    if (earlier !== undefined && earlier !== factory) {
      problem(table, `Cell ${cell} is listed under ${earlier} and ${factory}`, line);
    }
    factoryOf.set(cell, factory);
  }
  const rows = imported.flatMap((f) =>
    f.cells.filter((cell) => cell !== '').map((code) => ({ code, factory: f.factory })),
  );
  return {
    factories: imported.map((f) => f.factory),
    rows,
    report: {
      rows: table.rows.length,
      imported: rows.length,
      factories: imported.map((f) => f.factory),
      otherFactories: [...new Set(all.map((r) => r.factory))].filter((f) => !keep.has(f)),
    },
  };
}

function parseDefects(table: Table, problem: Problem) {
  if (table.rows.length !== DEFECT_COUNT) {
    problem(table, `Expected exactly ${DEFECT_COUNT} defects, found ${table.rows.length}`);
  }
  const rows: DefectInput[] = [];
  table.rows.forEach(({ line, cells }, i) => {
    // The id comes from the row number, so a blank row in between would shift every later id.
    if (line !== i + 2)
      problem(table, `Blank row before row ${line}; defect ids follow the rows`, line);
    const id = `D${String(line - 1).padStart(3, '0')}` as const;
    const severity = key(cells.CLASSIFICATION!).toUpperCase();
    if (isBlank(cells['DEFECT NAME']!)) problem(table, `${id} has no DEFECT NAME`, line);
    if (!SEVERITIES.includes(severity)) {
      problem(table, `${id} has CLASSIFICATION "${text(cells.CLASSIFICATION!)}"`, line);
    }
    rows.push({
      id,
      name: text(cells['DEFECT NAME']!),
      classification: severity as Classification,
      ctqCategory: optionalText(cells['DEFECT CLASSIFICATION']!),
      ctqCode: optionalText(cells['CTQ DEFECT CODE']!),
    });
  });
  return { rows };
}

function parseMapping(tables: MasterTables, defects: readonly DefectInput[], problem: Problem) {
  const uniqueIds = (table: Table, column: string): Map<string, TableRow> => {
    const seen = new Map<string, TableRow>();
    for (const row of table.rows) {
      const id = key(row.cells[column]!);
      if (id === '') problem(table, `Row without ${column}`, row.line);
      else if (seen.has(id)) problem(table, `${column} ${id} is listed twice`, row.line);
      else seen.set(id, row);
    }
    return seen;
  };
  const order = (table: Table, row: TableRow, what: string): number => {
    const n = positiveInteger(row.cells.DISPLAY_ORDER!);
    if (n === null) problem(table, `${what} has no whole-number DISPLAY_ORDER`, row.line);
    return n ?? 0;
  };
  const named = (table: Table, row: TableRow, column: string, what: string): string => {
    if (isBlank(row.cells[column]!)) problem(table, `${what} has no ${column}`, row.line);
    return text(row.cells[column]!);
  };

  const areaTable = tables.Area_Master;
  const areaRows = uniqueIds(areaTable, 'AREA_ID');
  const areaIds = [...areaRows.keys()];
  if (areaIds.length !== AREA_IDS.length || !AREA_IDS.every((id) => areaRows.has(id))) {
    problem(
      areaTable,
      `Areas must be exactly ${AREA_IDS[0]}–${AREA_IDS.at(-1)}; found ${areaIds.join(', ')}`,
    );
  }
  const areas = [...areaRows].map(([id, row]) => ({
    id: id as AreaInput['id'],
    name: named(areaTable, row, 'AREA_NAME', id),
    sort: order(areaTable, row, id),
  }));

  const subTable = tables.SubArea_Master;
  const subRows = uniqueIds(subTable, 'SUB_AREA_ID');
  const subAreas = [...subRows].map(([id, row]) => {
    const areaId = key(row.cells.AREA_ID!);
    if (!areaRows.has(areaId))
      problem(subTable, `${id} belongs to unknown area "${areaId}"`, row.line);
    return {
      id,
      areaId: areaId as SubAreaInput['areaId'],
      name: named(subTable, row, 'SUB_AREA_NAME', id),
      sort: order(subTable, row, id),
    };
  });
  const areaOfSub = new Map(subAreas.map((s) => [s.id, s.areaId as string]));

  const familyTable = tables.Defect_Family;
  const familyRows = uniqueIds(familyTable, 'FAMILY_ID');
  const families = [...familyRows].map(([id, row]) => ({
    id,
    name: named(familyTable, row, 'FAMILY_NAME', id),
  }));

  // Defect_Master gives each defect its family; its names must be DEFECT_LIST's names (doc 02 §5.1).
  const masterTable = tables.Defect_Master;
  const defectById = new Map(defects.map((d) => [d.id as string, d]));
  const familyOf = new Map<string, string>();
  for (const [id, row] of uniqueIds(masterTable, 'DEFECT_ID')) {
    const defect = defectById.get(id);
    const familyId = key(row.cells.FAMILY_ID!);
    if (!defect) {
      problem(masterTable, `${id} is not a defect of DEFECT_LIST`, row.line);
      continue;
    }
    if (text(row.cells.DEFECT_NAME!) !== defect.name) {
      problem(masterTable, `${id} is named differently than in DEFECT_LIST`, row.line);
    }
    if (!familyRows.has(familyId)) {
      problem(masterTable, `${id} has unknown FAMILY_ID "${familyId}"`, row.line);
    }
    familyOf.set(id, familyId);
  }

  const mapTable = tables.Defect_Area_Map;
  const combos = new Set<string>();
  const areaMap: AreaMapInput[] = [];
  for (const [mapId, row] of uniqueIds(mapTable, 'MAP_ID')) {
    const defectId = key(row.cells.DEFECT_ID!);
    const areaId = key(row.cells.AREA_ID!);
    const subAreaId = key(row.cells.SUB_AREA_ID!);
    const familyId = familyOf.get(defectId);
    if (familyId === undefined)
      problem(mapTable, `${mapId}: defect "${defectId}" is not in Defect_Master`, row.line);
    if (!areaRows.has(areaId)) problem(mapTable, `${mapId}: unknown area "${areaId}"`, row.line);
    const subArea = areaOfSub.get(subAreaId);
    if (subArea === undefined)
      problem(mapTable, `${mapId}: unknown sub-area "${subAreaId}"`, row.line);
    else if (subArea !== areaId) {
      problem(
        mapTable,
        `${mapId}: sub-area ${subAreaId} belongs to ${subArea}, not ${areaId}`,
        row.line,
      );
    }
    const combo = `${subAreaId}\u0000${familyId}\u0000${defectId}`;
    if (combos.has(combo))
      problem(mapTable, `${mapId}: ${subAreaId} / ${defectId} is mapped twice`, row.line);
    combos.add(combo);
    areaMap.push({
      mapId,
      areaId: areaId as AreaMapInput['areaId'],
      subAreaId,
      familyId: familyId ?? '',
      defectId: defectId as DefectId,
    });
  }

  const mapped = new Set(areaMap.map((m) => m.defectId as string));
  return {
    areas,
    subAreas,
    families,
    areaMap,
    report: {
      areas: areas.length,
      subAreas: subAreas.length,
      families: families.length,
      mapRows: areaMap.length,
      unmappedDefects: defects.map((d) => d.id as string).filter((id) => !mapped.has(id)),
    },
  };
}

interface PoRow {
  line: number;
  po: string;
  values: Record<(typeof PO_COLUMNS)[number], string | number | null>;
  orderQty: number | null;
}

function parsePos(table: Table) {
  const report: SourceReport['pos'] = {
    rows: table.rows.length,
    duplicatesMerged: 0,
    conflictGroups: 0,
    conflictRows: 0,
    otherSkippedRows: 0,
    unique: 0,
    unreadableDates: 0,
    conflicts: [],
    skipped: [],
  };

  // Pass 1: every row, grouped by PO number, before deciding anything.
  const groups = new Map<string, PoRow[]>();
  for (const { line, cells } of table.rows) {
    const po = text(cells.PO!);
    if (isBlank(cells.PO!)) {
      report.skipped.push({ line, po, reason: 'PO_EMPTY' });
      continue;
    }
    const dates = (['PODD', 'CRD'] as const).map((c) => {
      const date = parseDate(cells[c]!);
      if (date === null && !isBlank(cells[c]!)) report.unreadableDates++;
      return date;
    });
    const orderQty = positiveInteger(cells['ORDER QTY']!);
    const row: PoRow = {
      line,
      po,
      orderQty,
      values: {
        ARTICLE: text(cells.ARTICLE!),
        MODEL: text(cells.MODEL!),
        DESTINATION: text(cells.DESTINATION!),
        // An unusable quantity still takes part in the comparison, as its text.
        'ORDER QTY': orderQty ?? `invalid:${text(cells['ORDER QTY']!)}`,
        PODD: dates[0]!,
        CRD: dates[1]!,
      },
    };
    const group = groups.get(po);
    if (group) group.push(row);
    else groups.set(po, [row]);
  }

  // Pass 2: one decision per PO number.
  const rows: PoInput[] = [];
  for (const [po, group] of groups) {
    const first = group[0]!;
    const columns = PO_COLUMNS.filter((c) =>
      group.some((row) => row.values[c] !== first.values[c]),
    );
    if (columns.length > 0) {
      report.conflictGroups++;
      report.conflictRows += group.length;
      report.conflicts.push({ po, lines: group.map((r) => r.line), columns: [...columns] });
      continue;
    }
    if (first.orderQty === null) {
      for (const row of group)
        report.skipped.push({ line: row.line, po, reason: 'ORDER_QTY_INVALID' });
      continue;
    }
    report.duplicatesMerged += group.length - 1;
    rows.push({
      po,
      article: first.values.ARTICLE as string,
      model: first.values.MODEL as string,
      destination: first.values.DESTINATION as string,
      orderQty: first.orderQty,
      podd: first.values.PODD as string | null,
      crd: first.values.CRD as string | null,
      // FINISH PRODUCTION / Balance Prod are not imported until PRD OQ-06 is decided (doc 02 §3.3).
      finished: null,
    });
  }
  report.skipped.sort((a, b) => a.line - b.line);
  report.otherSkippedRows = report.skipped.length;
  report.unique = rows.length;
  return { rows, report };
}
