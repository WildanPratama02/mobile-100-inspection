import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findReferenceMapping,
  findSources,
  MAPPING_FILE,
  readOldSheets,
  readSources,
  SourceError,
  toTable,
} from './sources';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm100-import-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, text = ''): void {
  writeFileSync(join(dir, name), text, 'utf8');
}

const BOM = String.fromCharCode(0xfeff);

const CSV = {
  USER_LIST: 'ID,USERNAME,TYPE INSPECTION\n1,TEST ANDI,PSI lv.1\n',
  DB_CELL: 'ID,FACTORY,CELL\n1,F 1,F1-1\n',
  ALL_PO_MASTER:
    'PO,ARTICLE,MODEL,DESTINATION,ORDER QTY,PODD,CRD\n0902028839,FX3581, CORERACER ,"adidas, AG",17,2026-01-12,\n,,,,,,\n',
  DEFECT_LIST:
    'CTQ DEFECT CODE,DEFECT CLASSIFICATION,DEFECT NAME,CLASSIFICATION\n52.1,Outer carton,X,MINOR\n',
};

describe('findSources', () => {
  it('takes one workbook, and the mapping workbook from reference/ when the folder has none', () => {
    write('100%INLINE IMPACTIVA.xlsx');
    write('~$100%INLINE IMPACTIVA.xlsx');
    expect(findSources(dir)).toEqual({
      old: { kind: 'xlsx', file: join(dir, '100%INLINE IMPACTIVA.xlsx') },
      mapping: findReferenceMapping(),
    });
    expect(findReferenceMapping().endsWith(MAPPING_FILE)).toBe(true);
  });

  it('takes CSV files named after the sheet, also as Google Sheets names a downloaded tab', () => {
    write('100%INLINE IMPACTIVA - USER_LIST.csv');
    write('DB_CELL.csv');
    write('100%INLINE IMPACTIVA - ALL_PO_MASTER.csv');
    write('defect_list.CSV');
    write('Footwear_Defect_Mapping_Database_v2.xlsx');
    expect(findSources(dir)).toEqual({
      old: {
        kind: 'csv',
        files: {
          USER_LIST: join(dir, '100%INLINE IMPACTIVA - USER_LIST.csv'),
          DB_CELL: join(dir, 'DB_CELL.csv'),
          ALL_PO_MASTER: join(dir, '100%INLINE IMPACTIVA - ALL_PO_MASTER.csv'),
          DEFECT_LIST: join(dir, 'defect_list.CSV'),
        },
      },
      mapping: join(dir, 'Footwear_Defect_Mapping_Database_v2.xlsx'),
    });
  });

  it.each([
    [
      'a missing CSV',
      ['USER_LIST.csv', 'DB_CELL.csv', 'ALL_PO_MASTER.csv'],
      /No CSV file for DEFECT_LIST/,
    ],
    [
      'CSV files next to a workbook',
      ['USER_LIST.csv', 'export.xlsx'],
      /both CSV files and a workbook/,
    ],
    ['two workbooks', ['a.xlsx', 'b.xlsx'], /More than one workbook/],
    [
      'two CSV files for one sheet',
      ['USER_LIST.csv', 'x - USER_LIST.csv'],
      /More than one CSV file for USER_LIST/,
    ],
    ['an empty folder', [], /No master data/],
  ])('refuses %s', (_, files, message) => {
    for (const name of files) write(name);
    expect(() => findSources(dir)).toThrow(SourceError);
    expect(() => findSources(dir)).toThrow(message);
  });
});

describe('reading', () => {
  it('reads CSV text as it is, after a byte order mark, and leaves blank rows out', async () => {
    for (const [sheet, text] of Object.entries(CSV)) write(`${sheet}.csv`, BOM + text);
    const sources = findSources(dir);
    const tables = await readOldSheets(sources.old);
    expect(tables.ALL_PO_MASTER.rows).toEqual([
      {
        line: 2,
        cells: {
          PO: '0902028839',
          ARTICLE: 'FX3581',
          MODEL: ' CORERACER ',
          DESTINATION: 'adidas, AG',
          'ORDER QTY': '17',
          PODD: '2026-01-12',
          CRD: null,
        },
      },
    ]);
    expect(tables.USER_LIST.file).toBe('USER_LIST.csv');
  });

  it('names a missing column', async () => {
    for (const [sheet, text] of Object.entries(CSV)) write(`${sheet}.csv`, text);
    write('DB_CELL.csv', 'ID,FACTORY\n1,F 1\n');
    await expect(readOldSheets(findSources(dir).old)).rejects.toThrow(
      'DB_CELL in DB_CELL.csv has no column CELL',
    );
  });

  it('reads the mapping workbook, ignoring the side table next to Area_Master', async () => {
    for (const [sheet, text] of Object.entries(CSV)) write(`${sheet}.csv`, text);
    const tables = await readSources(findSources(dir));
    expect(tables.Area_Master.rows).toHaveLength(12);
    expect(tables.Defect_Area_Map.rows).toHaveLength(437);
    expect(tables.Defect_Master.rows[0]!.cells).toMatchObject({
      DEFECT_ID: 'D001',
      FAMILY_ID: 'F14',
    });
  });

  it('matches headers without case or surrounding spaces and refuses a column given twice', () => {
    const table = toTable(
      'DB_CELL',
      'x.csv',
      [
        [' factory ', 'Cell'],
        ['F 1', 'F1-1'],
      ],
      ['FACTORY', 'CELL'],
    );
    expect(table.rows).toEqual([{ line: 2, cells: { FACTORY: 'F 1', CELL: 'F1-1' } }]);
    expect(() =>
      toTable('DB_CELL', 'x.csv', [['FACTORY', 'CELL', 'cell']], ['FACTORY', 'CELL']),
    ).toThrow('has the column CELL twice');
  });
});
