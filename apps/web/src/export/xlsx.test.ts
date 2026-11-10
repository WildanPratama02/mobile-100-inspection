// @vitest-environment node
// jsdom's Uint8Array is another realm's, so fflate inside write-excel-file would zip byte arrays as
// folders; Node, like the browser, has one realm. The browser itself is covered by e2e/export.spec.ts.
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { formatDate } from '@m100/shared';
import { REPORT, REPORT_EMPTY, SHARED_NAME } from './testReport';
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

/** The sheet's rows, each a map of column letter to value, with shared strings resolved. */
function rows(xml: Record<string, string>): Array<Record<string, string>> {
  const shared = [
    ...(xml['xl/sharedStrings.xml'] ?? '').matchAll(/<si>.*?<t[^>]*>(.*?)<\/t>.*?<\/si>/g),
  ].map(([, value]) => unescapeXml(value ?? ''));
  const sheet = xml['xl/worksheets/sheet1.xml'] ?? '';
  return [...sheet.matchAll(/<row r="\d+"[^>]*>(.*?)<\/row>/g)].map(([, body]) =>
    Object.fromEntries(
      [...(body ?? '').matchAll(/<c r="([A-Z]+)\d+"([^>]*)>(.*?)<\/c>/g)].map(
        ([, column, attrs, inner]): [string, string] => {
          const value = /<v>(.*?)<\/v>/.exec(inner ?? '')?.[1] ?? '';
          return [
            column ?? '',
            (attrs ?? '').includes('t="s"') ? (shared[Number(value)] ?? '') : value,
          ];
        },
      ),
    ),
  );
}

/** The sheet's column A, row by row (empty rows become `''`). */
function columnA(xml: Record<string, string>): string[] {
  return rows(xml).map((row) => row['A'] ?? '');
}

function unescapeXml(value: string): string {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

/** The column A rows between two headings, without the blank spacer rows. */
function block(xml: Record<string, string>, from: string, to: string): string[] {
  const rows = columnA(xml);
  const start = rows.indexOf(from);
  const end = rows.indexOf(to);
  expect(start, from).toBeGreaterThanOrEqual(0);
  expect(end, to).toBeGreaterThan(start);
  return rows.slice(start + 1, end).filter((row) => row !== '');
}

describe('toXlsx (FR-12)', () => {
  it('has exactly one sheet, PSI Report (ADR-022)', async () => {
    const xml = await parts(REPORT);
    expect(SUMMARY_SHEET).toBe('PSI Report');
    expect(xml['xl/workbook.xml']).toContain(`name="${SUMMARY_SHEET}"`);
    expect(xml['xl/workbook.xml']).not.toContain('Daftar Defect');
    expect(xml['xl/worksheets/sheet2.xml']).toBeUndefined();
  });

  it('lays the sheet out in the template order: title, Part I, Part II, Part III, findings', async () => {
    const xml = await parts(REPORT);
    const all = text(xml);
    expect(all).toContain('PSI Inspection Report');
    expect(columnA(xml).filter((row) => row !== '')).toEqual([
      'PSI Inspection Report',
      'Part I: General Data',
      'Date',
      'PSI Name',
      'Part II: KPI Summary',
      ...REPORT.kpi.map((r) => r.label),
      'Part III: Daily Inspection Summary',
      ...REPORT.summary.map((row) => row.label),
      'Defect Findings List',
      'No',
      ...REPORT.defects.map((d) => String(d.no)),
    ]);
    // Part I is the general data: the inspection date and the PSI name.
    expect(all).toContain(formatDate(REPORT.date));
    expect(all).toContain(REPORT.psiName);
  });

  it('has Part II in the docs order with every KPI value (ADR-022)', async () => {
    const xml = await parts(REPORT);
    expect(REPORT.kpi).toHaveLength(8);
    expect(block(xml, 'Part II: KPI Summary', 'Part III: Daily Inspection Summary')).toEqual(
      REPORT.kpi.map((r) => r.label),
    );
    const sheet1 = xml['xl/worksheets/sheet1.xml']!;
    // Counts are numbers, rates are percentages: 23/30 and 7/30, 1/30.
    expect(sheet1).toContain('<v>30</v>');
    expect(sheet1).toContain('<v>31</v>');
    expect(sheet1).toContain('<v>24</v>');
    expect(sheet1).toContain(`<v>${23 / 30}</v>`);
    expect(sheet1).toContain(`<v>${7 / 30}</v>`);
    expect(sheet1).toContain(`<v>${1 / 30}</v>`);
    expect(xml['xl/styles.xml']).toContain('0.0%');
  });

  it('draws thin table borders and the gray header fill like the reference template', async () => {
    const xml = await parts(REPORT);
    const styles = xml['xl/styles.xml']!;
    expect(styles).toContain('style="thin"');
    expect(styles).toContain('D9D9D9');
    // Only the title row stays without a style beyond its font; the table cells carry border styles.
    const sheet1 = xml['xl/worksheets/sheet1.xml']!;
    expect(sheet1.match(/ s="\d+"/g)?.length ?? 0).toBeGreaterThan(20);
  });

  it('has the thirteen Part III rows in the docs order (ADR-022, 30 Oct 2026)', async () => {
    const xml = await parts(REPORT);
    const all = text(xml);
    expect(REPORT.summary).toHaveLength(13);
    expect(block(xml, 'Part III: Daily Inspection Summary', 'Defect Findings List')).toEqual(
      REPORT.summary.map((row) => row.label),
    );
    // `&` is `&amp;` inside the XML.
    expect(all).toContain('Pairs Not Reworkable &amp; Not Shippable');
    // The PO text fields stay text, the figures are numbers.
    expect(all).toContain('JAPAN');
    expect(all).toContain('<v>1200</v>');
  });

  it('lists every defect finding with its severity and share, never only five (ADR-022)', async () => {
    const xml = await parts(REPORT);
    const all = text(xml);
    expect(all).not.toContain('TOP 5');
    expect(all).toContain('Severity');
    expect(all).toContain('% of QTY INSPECTION');
    // One row per defect: No, the name exactly as in the mapping, severity, Qty and share.
    const list = rows(xml).slice(-REPORT.defects.length);
    expect(list.map((row) => [row['A'], row['B'], row['C'], row['D']])).toEqual(
      REPORT.defects.map((d) => [String(d.no), d.name, d.classification, String(d.qty)]),
    );
    expect(REPORT.defects).toHaveLength(6);
    expect(all).toContain(`<v>${2 / 30}</v>`);
    // No photo section, no template formula, no area column.
    expect(all).not.toContain('Foto');
    expect(all).not.toContain('<f>');
    expect(all).not.toContain('Sub Area');
  });

  it('gives D049 and D071 a row each although they share a name (ADR-009)', async () => {
    const list = rows(await parts(REPORT)).filter((row) => row['B'] === SHARED_NAME);
    // Two rows, numbered by their own ranks: the defects are kept apart by DEFECT_ID, not merged by name.
    expect(list.map((row) => row['A'])).toEqual(['5', '6']);
    expect(REPORT.defects.filter((d) => d.name === SHARED_NAME).map((d) => d.defectId)).toEqual([
      'D049',
      'D071',
    ]);
  });

  it('an empty session shows "Belum ada defect." and zero figures (doc 05 §8.5)', async () => {
    const xml = await parts(REPORT_EMPTY);
    const all = text(xml);
    expect(all).toContain('Belum ada defect.');
    expect(REPORT_EMPTY.results.slice(1).every((r) => r.value === 0)).toBe(true);
    // Every empty figure is a 0 in the sheet, not a blank cell or the old "—" (31 Oct 2026).
    const sheet1 = xml['xl/worksheets/sheet1.xml']!;
    expect(sheet1.match(/<v>0<\/v>/g)?.length ?? 0).toBeGreaterThan(10);
    expect(all).not.toContain('—');
  });
});
