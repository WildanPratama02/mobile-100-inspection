import { ImportInvalid, parseMaster, type ImportProblem } from './parse-master';
import type { CellValue, MasterTables, Table } from './sources';
import { FIXTURE_PO_EXPECTED, FIXTURE_POS, fixtureTables } from '../testing/master-fixtures';

function problemsOf(tables: MasterTables): ImportProblem[] {
  try {
    parseMaster(tables);
  } catch (error) {
    if (error instanceof ImportInvalid) return [...error.problems];
    throw error;
  }
  throw new Error('Expected ImportInvalid');
}

/** A copy of the table with one cell of the row `line` changed. */
function withCell(table: Table, line: number, column: string, value: CellValue): Table {
  return {
    ...table,
    rows: table.rows.map((row) =>
      row.line === line ? { ...row, cells: { ...row.cells, [column]: value } } : row,
    ),
  };
}

describe('parseMaster: users and cells (doc 02 §3.1, §3.2)', () => {
  it('keeps PSI lv.1 and lv.2 only, once per (name, level), sorted by name', async () => {
    const { users, report } = parseMaster(await fixtureTables());
    expect(users).toEqual([
      { username: 'TEST ANDI', level: 'PSI lv.1' },
      { username: 'TEST BUDI', level: 'PSI lv.2' },
      { username: 'TEST CITRA', level: 'PSI lv.1' },
      { username: 'TEST DEWI', level: 'PSI lv.1' },
      { username: 'TEST DEWI', level: 'PSI lv.2' },
    ]);
    expect(report.users).toEqual({ rows: 8, psiRows: 6, otherTypeRows: 2, unique: 5 });
  });

  it('imports F <number> factories only, each cell once', async () => {
    const { factories, cells, report } = parseMaster(await fixtureTables());
    expect(factories).toEqual(['F 1', 'F 2']);
    expect(cells).toEqual([
      { code: 'F1-1', factory: 'F 1' },
      { code: 'F1-2', factory: 'F 1' },
      { code: 'F2-1', factory: 'F 2' },
    ]);
    expect(report.cells.otherFactories).toEqual(['PWA', 'BOTTOM']);
  });

  it('stops on a PSI row without a name and on a cell under two factories', async () => {
    const tables = await fixtureTables({
      users: [
        ['ID', 'USERNAME', 'TYPE INSPECTION'],
        [1, '  ', 'PSI lv.2'],
      ],
      cells: [
        ['ID', 'FACTORY', 'CELL'],
        [1, 'F 1', 'F1-1'],
        [2, 'F 2', 'F1-1'],
      ],
    });
    expect(problemsOf(tables)).toEqual([
      { sheet: 'USER_LIST', line: 2, message: 'PSI lv.2 row without USERNAME' },
      { sheet: 'DB_CELL', line: 3, message: 'Cell F1-1 is listed under F 1 and F 2' },
    ]);
  });
});

describe('parseMaster: defects and the area map (doc 02 §3.4, §3.5)', () => {
  it('numbers the 98 defects D001…D098 by row and keeps D049 and D071 apart', async () => {
    const { defects, report } = parseMaster(await fixtureTables());
    expect(defects).toHaveLength(98);
    expect(defects[0]!.id).toBe('D001');
    expect(defects.at(-1)!.id).toBe('D098');
    const d049 = defects.find((d) => d.id === 'D049')!;
    const d071 = defects.find((d) => d.id === 'D071')!;
    expect(d049.name).toBe('POOR TOUCH UP/PAINTING, MARKING LINE');
    expect(d071.name).toBe(d049.name);
    expect(report.defects.rows).toBe(98);
  });

  it('reads 12 areas, their sub-areas, the families and 437 map rows, each with its defect family', async () => {
    const { areas, subAreas, areaMap, report } = parseMaster(await fixtureTables());
    expect(areas.map((a) => a.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`),
    );
    expect(subAreas.find((s) => s.id === 'SA03M')?.areaId).toBe('A03');
    expect(areaMap).toHaveLength(437);
    expect(areaMap.find((m) => m.mapId === 'MAP-001-01')).toEqual({
      mapId: 'MAP-001-01',
      areaId: 'A12',
      subAreaId: 'SA12P',
      familyId: 'F14',
      defectId: 'D001',
    });
    expect(report.mapping).toMatchObject({ areas: 12, mapRows: 437, unmappedDefects: [] });
  });

  it('stops when DEFECT_LIST does not have exactly 98 rows', async () => {
    const tables = await fixtureTables({ defects: (rows) => rows.slice(0, 97) });
    expect(problemsOf(tables)).toContainEqual({
      sheet: 'DEFECT_LIST',
      message: 'Expected exactly 98 defects, found 97',
    });
  });

  it('stops on an unknown severity and on a name that differs from the mapping workbook', async () => {
    const tables = await fixtureTables({
      defects: (rows) =>
        rows.map((row, i) =>
          i === 4
            ? [row[0]!, row[1]!, row[2]!, 'SEVERE']
            : i === 9
              ? [row[0]!, row[1]!, 'renamed', row[3]!]
              : row,
        ),
    });
    expect(problemsOf(tables)).toEqual([
      { sheet: 'DEFECT_LIST', line: 6, message: 'D005 has CLASSIFICATION "SEVERE"' },
      {
        sheet: 'Defect_Master',
        line: 11,
        message: 'D010 is named differently than in DEFECT_LIST',
      },
    ]);
  });

  it('stops on a map row whose sub-area belongs to another area, and on a missing area', async () => {
    const tables = await fixtureTables();
    const line = tables.Defect_Area_Map.rows[0]!.line;
    tables.Defect_Area_Map = withCell(tables.Defect_Area_Map, line, 'SUB_AREA_ID', 'SA01');
    tables.Area_Master = { ...tables.Area_Master, rows: tables.Area_Master.rows.slice(0, 11) };
    const problems = problemsOf(tables);
    expect(problems).toContainEqual({
      sheet: 'Defect_Area_Map',
      line,
      message: 'MAP-001-01: sub-area SA01 belongs to A01, not A12',
    });
    expect(
      problems.some((p) => p.sheet === 'Area_Master' && /exactly A01–A12/.test(p.message)),
    ).toBe(true);
  });
});

describe('parseMaster: POs (doc 02 §3.3, §5.1)', () => {
  it('keeps text exactly, takes digits-only text as a quantity and reads ISO and workbook dates', async () => {
    const { pos, poSource } = parseMaster(await fixtureTables());
    expect(pos.map((p) => p.po)).toEqual(FIXTURE_PO_EXPECTED.imported);
    expect(pos[0]).toEqual({
      po: '0902028839',
      article: 'FX3581',
      model: 'CORERACER',
      destination: 'adidas International Trading AG',
      orderQty: 17,
      podd: '2026-01-12',
      crd: '2026-01-12',
      finished: null,
    });
    expect(pos[1]).toMatchObject({ model: 'DURAMO SL2 M', podd: '2026-02-01', crd: '2026-02-03' });
    expect(pos.find((p) => p.po === 'PO-TEXTQTY')?.orderQty).toBe(17);
    expect(pos.find((p) => p.po === 'PO-BADDATE')).toMatchObject({ podd: null, crd: null });
    expect(poSource).toBe('import:fixture.xlsx');
  });

  it('merges identical rows of a PO, skips every row of a conflicting PO, and reports the rest', async () => {
    const { report } = parseMaster(await fixtureTables());
    const { conflicts, skipped, ...counts } = report.pos;
    const { imported, ...expected } = FIXTURE_PO_EXPECTED;
    expect(counts).toEqual({ ...expected, unique: imported.length });
    expect(conflicts).toEqual([
      { po: 'PO-CONFLICT', lines: [4, 12], columns: ['ORDER QTY', 'CRD'] },
    ]);
    expect(skipped).toEqual([
      { line: 7, po: '', reason: 'PO_EMPTY' },
      { line: 8, po: 'PO-BADQTY', reason: 'ORDER_QTY_INVALID' },
      { line: 13, po: 'PO-ZERO', reason: 'ORDER_QTY_INVALID' },
    ]);
  });

  it('finds a conflict however far apart the rows are, so no copy of the PO is imported', async () => {
    const filler = Array.from({ length: 50 }, (_, i): CellValue[] => [
      `PO-${i}`,
      'A',
      'M',
      'D',
      1,
      null,
      null,
    ]);
    const header = FIXTURE_POS[0]!;
    const tables = await fixtureTables({
      pos: [
        header,
        ['PO-LATE', 'A', 'M', 'D', 5, null, null],
        ...filler,
        ['PO-LATE', 'A', 'M', 'D2', 5, null, null],
      ],
    });
    const { pos, report } = parseMaster(tables);
    expect(pos.map((p) => p.po)).not.toContain('PO-LATE');
    expect(pos).toHaveLength(50);
    expect(report.pos.conflicts).toEqual([
      { po: 'PO-LATE', lines: [2, 53], columns: ['DESTINATION'] },
    ]);
  });

  it('treats a quantity that is unusable in every copy as one skipped PO, and a mixed one as a conflict', async () => {
    const header = FIXTURE_POS[0]!;
    const tables = await fixtureTables({
      pos: [
        header,
        ['PO-A', 'A', 'M', 'D', 'n/a', null, null],
        ['PO-A', 'A', 'M', 'D', 'n/a', null, null],
        ['PO-B', 'A', 'M', 'D', 'n/a', null, null],
        ['PO-B', 'A', 'M', 'D', 3, null, null],
      ],
    });
    const { pos, report } = parseMaster(tables);
    expect(pos).toEqual([]);
    expect(report.pos.skipped.map((s) => [s.line, s.reason])).toEqual([
      [2, 'ORDER_QTY_INVALID'],
      [3, 'ORDER_QTY_INVALID'],
    ]);
    expect(report.pos.conflicts).toEqual([{ po: 'PO-B', lines: [4, 5], columns: ['ORDER QTY'] }]);
  });
});
