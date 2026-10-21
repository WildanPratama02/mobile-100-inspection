/**
 * Test helper: master data for `import-master` tests, built in memory. The mapping is the real workbook in
 * `reference/mapping/` (it holds no personal data); `DEFECT_LIST` is derived from its `Defect_Master`, so the names
 * agree. Users, cells and POs are made up: no real name from the old `USER_LIST` appears in the repository.
 */
import {
  findReferenceMapping,
  type CellValue,
  type MasterTables,
  readMapping,
  toTable,
  OLD_SHEETS,
} from '../import/sources';

const NBSP = ' ';

export const FIXTURE_USERS: CellValue[][] = [
  ['ID', 'USERNAME', 'TYPE INSPECTION'],
  [1, 'TEST ANDI', 'PSI lv.1'],
  [2, 'TEST BUDI', 'PSI lv.2'],
  [3, 'TEST BUDI', 'PSI lv.2'],
  [4, 'TEST CITRA', 'CFA'],
  [5, 'TEST CITRA', 'PSI lv.1'],
  [6, 'TEST DEWI', 'PSI lv.1'],
  [7, 'TEST DEWI', 'PSI lv.2'],
  [8, 'TEST EKO', 'T1QM'],
];

export const FIXTURE_CELLS: CellValue[][] = [
  ['ID', 'FACTORY', 'CELL'],
  [1, 'F 1', 'F1-1'],
  [2, 'F 1', 'F1-2'],
  [3, 'F 2', 'F2-1'],
  [4, 'PWA', 'PWA-1'],
  [5, 'BOTTOM', 'BTM-1'],
  [6, 'F 1', 'F1-1'],
];

const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Row numbers in comments are the sheet rows the report names. */
export const FIXTURE_POS: CellValue[][] = [
  [
    'PO',
    'ARTICLE',
    'MODEL',
    'DESTINATION',
    'ORDER QTY',
    'PODD',
    'CRD',
    'Balance Prod',
    'FINISH PRODUCTION',
  ],
  /* 2 */ [
    '0902028839',
    'FX3581',
    'CORERACER',
    'adidas International Trading AG',
    17,
    date('2026-01-12'),
    date('2026-01-12'),
    0,
    null,
  ],
  /* 3 */ [
    'CX-0902368685',
    'IH8217',
    `DURAMO${NBSP}SL2 M`,
    'ADIDAS SOUTH AFRICA',
    1200,
    '2026-02-01',
    '2026-02-03T00:00:00.000Z',
    null,
    null,
  ],
  /* 4 */ [
    'PO-CONFLICT',
    'KI3582',
    'TAEKWONDO',
    'ADIDAS SOUTH AFRICA',
    376,
    date('2026-03-01'),
    date('2026-03-01'),
    null,
    null,
  ],
  /* 5 */ ['PO-DUP', 'JR1234', 'SAMBA', 'ADIDAS JAPAN', 40, date('2026-03-05'), null, null, null],
  /* 6 */ ['PO-DUP', 'JR1234', 'SAMBA', 'ADIDAS JAPAN', '40', '2026-03-05', null, 5, null],
  /* 7 */ [null, 'AB0001', 'NO PO', 'X', 10, null, null, null, null],
  /* 8 */ ['PO-BADQTY', 'AB0002', 'BAD QTY', 'X', 'abc', null, null, null, null],
  /* 9 */ ['PO-TEXTQTY', 'AB0003', 'TEXT QTY', 'X', '17', null, null, null, null],
  /* 10 */ ['PO-BADDATE', 'AB0004', 'BAD DATE', 'X', 5, 'soon', '31/12/2026', null, null],
  /* 11 */ [null, null, null, null, null, null, null, null, null],
  /* 12 */ [
    'PO-CONFLICT',
    'KI3582',
    'TAEKWONDO',
    'ADIDAS SOUTH AFRICA',
    8,
    date('2026-03-01'),
    date('2026-03-09'),
    null,
    null,
  ],
  /* 13 */ ['PO-ZERO', 'AB0005', 'ZERO', 'X', 0, null, null, null, null],
];

/** The POs the fixture imports, and what the report must say about the rest. */
export const FIXTURE_PO_EXPECTED = {
  imported: ['0902028839', 'CX-0902368685', 'PO-DUP', 'PO-TEXTQTY', 'PO-BADDATE'],
  rows: 11,
  duplicatesMerged: 1,
  conflictGroups: 1,
  conflictRows: 2,
  otherSkippedRows: 3,
  unreadableDates: 2,
};

export interface FixtureOverrides {
  users?: CellValue[][];
  cells?: CellValue[][];
  pos?: CellValue[][];
  /** Changes the derived `DEFECT_LIST` rows (header excluded) before they become a table. */
  defects?: (rows: CellValue[][]) => CellValue[][];
}

let mapping: Promise<Awaited<ReturnType<typeof readMapping>>> | undefined;

export async function fixtureTables(overrides: FixtureOverrides = {}): Promise<MasterTables> {
  mapping ??= readMapping(findReferenceMapping());
  const map = await mapping;
  // DEFECT_LIST row r is D(r−1); Defect_Master lists D001…D098 in that order.
  const defectRows: CellValue[][] = map.Defect_Master.rows.map(({ cells }, i) => [
    `52.${i + 1}`,
    'Category',
    cells.DEFECT_NAME!,
    severityOf(i),
  ]);
  const defects = [
    ['CTQ DEFECT CODE', 'DEFECT CLASSIFICATION', 'DEFECT NAME', 'CLASSIFICATION'],
    ...(overrides.defects ? overrides.defects(defectRows) : defectRows),
  ];
  return {
    USER_LIST: toTable(
      'USER_LIST',
      'fixture.xlsx',
      overrides.users ?? FIXTURE_USERS,
      OLD_SHEETS.USER_LIST,
    ),
    DB_CELL: toTable(
      'DB_CELL',
      'fixture.xlsx',
      overrides.cells ?? FIXTURE_CELLS,
      OLD_SHEETS.DB_CELL,
    ),
    ALL_PO_MASTER: toTable(
      'ALL_PO_MASTER',
      'fixture.xlsx',
      overrides.pos ?? FIXTURE_POS,
      OLD_SHEETS.ALL_PO_MASTER,
    ),
    DEFECT_LIST: toTable('DEFECT_LIST', 'fixture.xlsx', defects, OLD_SHEETS.DEFECT_LIST),
    ...map,
  };
}

/** Any valid severity will do for the fixture; the real ones come from the old sheet. */
function severityOf(index: number): string {
  return ['MINOR', 'MAJOR', 'CRITICAL'][index % 3]!;
}
