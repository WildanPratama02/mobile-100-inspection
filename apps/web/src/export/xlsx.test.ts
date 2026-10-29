// @vitest-environment node
// jsdom's Uint8Array is another realm's, so fflate inside write-excel-file would zip byte arrays as
// folders; Node, like the browser, has one realm. The browser itself is covered by e2e/export.spec.ts.
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { REPORT, REPORT_EMPTY } from './testReport';
import { SUMMARY_SHEET, toXlsx, XLSX_TYPE } from './xlsx';
import type { ExportReport } from './report';

/** The workbook's XML parts by name. */
async function parts(report: ExportReport): Promise<Record<string, string>> {
  const blob = await toXlsx(report);
  expect(blob.type).toBe(XLSX_TYPE);
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, strFromU8(data)]));
}

/** Every string and number the workbook holds, in one text to search. */
function text(xml: Record<string, string>): string {
  return Object.values(xml).join('\n');
}

describe('toXlsx (FR-12)', () => {
  it('has the one sheet Ringkasan, no Daftar Defect (ADR-021)', async () => {
    const xml = await parts(REPORT);
    expect(xml['xl/workbook.xml']).toContain(`name="${SUMMARY_SHEET}"`);
    expect(xml['xl/workbook.xml']).not.toContain('Daftar Defect');
    expect(xml['xl/worksheets/sheet2.xml']).toBeUndefined();
  });

  it('holds the header, results and Top 5 without a Foto column (AC-12.1, ADR-021)', async () => {
    const all = text(await parts(REPORT));
    for (const [label, value] of REPORT.info) {
      expect(all).toContain(label);
      expect(all).toContain(value);
    }
    for (const r of REPORT.results) expect(all).toContain(r.label);
    expect(all).toContain('TOP 5 DEFECT');
    expect(all).toContain('VAMP, TOE BOX');
    for (const t of REPORT.top5) expect(all).toContain(t.name);
    expect(all).not.toContain('Foto');
    expect(all).not.toContain('Sub Area');
  });

  it('writes quantities as numbers and rates as percentages', async () => {
    const xml = await parts(REPORT);
    const sheet1 = xml['xl/worksheets/sheet1.xml']!;
    expect(sheet1).toContain('<v>10002</v>');
    expect(sheet1).toContain(`<v>${3 / 16}</v>`);
    expect(xml['xl/styles.xml']).toContain('0.0%');
  });

  it('an empty session shows "Belum ada defect." and "—" for the rates (doc 05 §8.5)', async () => {
    const all = text(await parts(REPORT_EMPTY));
    expect(all).toContain('Belum ada defect.');
    expect(all).toContain('—');
  });
});
