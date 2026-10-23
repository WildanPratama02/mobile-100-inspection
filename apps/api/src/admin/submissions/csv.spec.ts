import type { SubmissionRow } from '../../repositories/submission-admin.repository';
import {
  CSV_BOM,
  csvField,
  csvHeader,
  csvLine,
  EXPORT_COLUMNS,
  exportCells,
  safeText,
} from './csv';

const ROW: SubmissionRow = {
  id: '0f6b6c1e-6a52-4c9f-9a3e-5d7a2b0c41f2',
  displayNo: 123,
  sealedAt: new Date('2026-10-16T07:32:05.000Z'),
  receivedAt: new Date('2026-10-16T07:32:07.000Z'),
  inspectionDate: '2026-10-16',
  appVersion: '1.0.0',
  username: 'AZIZAH',
  level: 'PSI lv.2',
  factory: 'F 3',
  cell: 'F3-10',
  po: '0903359388',
  article: 'IH1234',
  model: 'RUNNER X, "LOW"',
  destination: 'JAPAN',
  orderQty: 10002,
  podd: '2026-01-12',
  crd: null,
  partialNo: 1,
  partialQty: 1200,
  partialText: 'P1 1.200 OF 10.002',
  qtyRework: 10,
  qtyBGradeInspections: 2,
  qtyNoDefect: 18,
  qtyInspection: 30,
  qtyAGrade: 18,
  qtyBGrade: 3,
  qtyDefect: 11,
  rft: '0.60000',
  defectRate: '0.36667',
  photoCount: 2,
  countingRule: 'ADR-008',
};

describe('CSV fields (RFC 4180)', () => {
  it('quotes a field with a comma, a quote, CR or LF and doubles the quotes', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField('cr\r')).toBe('"cr\r"');
  });

  it('writes null as an empty field and numbers as they are', () => {
    expect(csvLine([null, 0, 10002, '0.60000'])).toBe(',0,10002,0.60000\r\n');
  });

  it('starts with the BOM and the header, comma separated, CRLF ended', () => {
    const header = csvHeader();
    expect(header.startsWith(CSV_BOM)).toBe(true);
    expect(header).toBe(`${CSV_BOM}${EXPORT_COLUMNS.join(',')}\r\n`);
    expect(EXPORT_COLUMNS.slice(-3)).toEqual(['top5_defect_id', 'top5_defect_name', 'top5_qty']);
  });
});

describe('safeText (CSV injection)', () => {
  it.each(['=SUM(A1)', '+1', '-1', '@cmd', '\tx', '\rx'])('prefixes %j with a quote', (text) => {
    expect(safeText(text)).toBe(`'${text}`);
  });

  it('leaves ordinary text alone', () => {
    expect(safeText('DIRTY (Stain)')).toBe('DIRTY (Stain)');
    expect(safeText('F3-10')).toBe('F3-10');
  });
});

describe('exportCells', () => {
  const cells = exportCells(ROW, [
    { defectId: 'D035', defectName: 'BOND GAP', qty: 3 },
    { defectId: 'D082', defectName: '=HYPERLINK("x")', qty: 2 },
  ]);
  const byColumn = Object.fromEntries(EXPORT_COLUMNS.map((c, i) => [c, cells[i]]));

  it('has one cell per column', () => {
    expect(cells).toHaveLength(EXPORT_COLUMNS.length);
  });

  it('writes raw numbers with a dot and the times in WIB', () => {
    expect(byColumn).toMatchObject({
      display_no: 'M100-000123',
      sealed_at: '2026-10-16T14:32:05.000+07:00',
      inspection_date: '2026-10-16',
      order_qty: 10002,
      partial_text: 'P1 1.200 OF 10.002',
      rft: '0.60000',
      defect_rate: '0.36667',
      crd: null,
      counting_rule: 'ADR-008',
    });
  });

  it('keeps text exactly, non-breaking spaces included, and quotes it in the line', () => {
    expect(byColumn.model).toBe('RUNNER X, "LOW"');
    expect(csvLine(cells)).toContain(',"RUNNER X, ""LOW""",');
  });

  it('fills the Top 5 places in order and leaves the missing ones empty', () => {
    expect(byColumn).toMatchObject({
      top1_defect_id: 'D035',
      top1_defect_name: 'BOND GAP',
      top1_qty: 3,
      top2_defect_id: 'D082',
      top2_defect_name: `'=HYPERLINK("x")`,
      top3_defect_id: null,
      top5_qty: null,
    });
  });
});
