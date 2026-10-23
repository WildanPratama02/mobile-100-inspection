import { PO_IMPORT_COLUMNS, PO_IMPORT_SHEET, parsePoImport } from './parse-po-import';
import { type CellValue, toTable } from './sources';

const HEADER = ['PO', 'ARTICLE', 'MODEL', 'DESTINATION', 'ORDER QTY', 'PODD', 'CRD'];
const table = (...rows: CellValue[][]) =>
  toTable(PO_IMPORT_SHEET, 'pos.csv', [HEADER, ...rows], PO_IMPORT_COLUMNS);

describe('parsePoImport (doc 04 §8, §10 A9)', () => {
  it('keeps text exactly, reads ISO text and workbook dates, and merges identical rows of one PO', () => {
    const parsed = parsePoImport(
      table(
        ['0902028839', 'AB1234', 'RUNNER\u00a0X', 'JAPAN', '1200', '2026-01-12', null],
        ['CX-0902368685', ' ab ', 'M', '', 300, new Date('2026-03-01T00:00:00Z'), '2026-03-09'],
        ['0902028839', 'AB1234', 'RUNNER\u00a0X', 'JAPAN', 1200, '2026-01-12', ''],
        [null, null, null, null, null, null, null],
      ),
    );
    expect(parsed).toEqual({
      read: 3,
      duplicatesMerged: 1,
      errors: [],
      rows: [
        {
          po: '0902028839',
          article: 'AB1234',
          model: 'RUNNER\u00a0X',
          destination: 'JAPAN',
          orderQty: 1200,
          podd: '2026-01-12',
          crd: null,
          finished: null,
        },
        {
          po: 'CX-0902368685',
          article: ' ab ',
          model: 'M',
          destination: '',
          orderQty: 300,
          podd: '2026-03-01',
          crd: '2026-03-09',
          finished: null,
        },
      ],
    });
  });

  it('makes every row the one-time import would skip an error, by row, and a date that is not one too', () => {
    const parsed = parsePoImport(
      table(
        ['', 'A', 'M', 'D', 10, null, null],
        ['PO-QTY', 'A', 'M', 'D', '1.5', null, null],
        ['PO-ZERO', 'A', 'M', 'D', 0, null, null],
        ['PO-DATE', 'A', 'M', 'D', 10, '12/01/2026', null],
        ['PO-CONF', 'A', 'M', 'D', 10, null, null],
        ['PO-OK', 'A', 'M', 'D', 10, null, '2026-02-30'],
        ['PO-CONF', 'A', 'M', 'D', 11, null, null],
      ),
    );
    expect(parsed.errors).toEqual([
      { line: 2, code: 'PO_EMPTY', message: 'Kolom PO kosong.' },
      {
        line: 3,
        code: 'ORDER_QTY_INVALID',
        message: 'PO PO-QTY: ORDER QTY "1.5" bukan bilangan bulat ≥ 1.',
      },
      {
        line: 4,
        code: 'ORDER_QTY_INVALID',
        message: 'PO PO-ZERO: ORDER QTY "0" bukan bilangan bulat ≥ 1.',
      },
      {
        line: 5,
        code: 'DATE_INVALID',
        message: 'PO PO-DATE: PODD "12/01/2026" bukan tanggal (YYYY-MM-DD).',
      },
      {
        line: 6,
        code: 'PO_CONFLICT',
        message: 'PO PO-CONF ada di baris 6, 8 dengan nilai berbeda (ORDER QTY).',
      },
      {
        line: 7,
        code: 'DATE_INVALID',
        message: 'PO PO-OK: CRD "2026-02-30" bukan tanggal (YYYY-MM-DD).',
      },
      {
        line: 8,
        code: 'PO_CONFLICT',
        message: 'PO PO-CONF ada di baris 6, 8 dengan nilai berbeda (ORDER QTY).',
      },
    ]);
    expect(parsed.rows).toEqual([]);
    expect(parsed.read).toBe(7);
  });
});
