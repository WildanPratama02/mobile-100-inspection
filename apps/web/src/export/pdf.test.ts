import { describe, expect, it } from 'vitest';
import { toPdf, type PdfAssets } from './pdf';
import { EXPORT_TITLE, type ExportReport } from './report';
import { JPEG, LOGO, REPORT, REPORT_EMPTY, REPORT_LV1 } from './testReport';

function assets(report: ExportReport): PdfAssets {
  return { logo: LOGO, photos: new Map(report.photos.map((p) => [p.defectId, JPEG])) };
}

/** The PDF as text; jsPDF writes its content streams uncompressed, so drawn text is readable. */
async function pdfText(report: ExportReport): Promise<string> {
  const blob = toPdf(report, assets(report));
  expect(blob.type).toBe('application/pdf');
  return new TextDecoder('latin1').decode(await blob.arrayBuffer());
}

describe('toPdf (FR-12)', () => {
  it('is a PDF with the title, PO info, results, Top 5 and the defect list (AC-12.1)', async () => {
    const pdf = await pdfText(REPORT);
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(pdf).toContain(`(${EXPORT_TITLE})`);
    // PDF strings escape their parentheses.
    for (const value of ['0903359388', 'RUNNER CONTOH 1', 'DEWI CONTOH \\(PSI lv.2\\)', 'F3-10']) {
      expect(pdf).toContain(value);
    }
    expect(pdf).toContain('19 Okt 2026 14.05 WIB');
    expect(pdf).toContain('Qty Inspection');
    expect(pdf).toContain('(10.002)');
    expect(pdf).toContain('18,8%');
    expect(pdf).toContain('TOP 5 DEFECT');
    expect(pdf).toContain('DAFTAR DEFECT');
    for (const value of ['BOND GAP', 'Vamp Center', 'Bonding', 'B-GRADE', 'CRITICAL']) {
      expect(pdf).toContain(value);
    }
    expect(pdf).toContain('Halaman 1 / ');
  });

  it('includes the attached photos with their defect names (AC-12.2)', async () => {
    const pdf = await pdfText(REPORT);
    expect(pdf).toContain('FOTO DEFECT');
    expect(pdf).toContain('/DCTDecode');
    expect(pdf).toContain('(1. BOND GAP)');
    expect(pdf).toContain('(2. WRINKLE)');
    // Outside the Top 5: the name only (AC-10.4).
    expect(pdf).toContain('(STAIN OUTSIDE)');
  });

  it('has the logo but no photo section for PSI lv.1', async () => {
    const pdf = await pdfText(REPORT_LV1);
    expect(pdf).toContain('/Subtype /Image');
    expect(pdf).not.toContain('/DCTDecode');
    expect(pdf).not.toContain('FOTO DEFECT');
  });

  it('an empty session shows "Belum ada defect." and "—" for the rates (doc 05 §8.5)', async () => {
    const pdf = await pdfText(REPORT_EMPTY);
    expect(pdf).toContain('Belum ada defect.');
    // Helvetica is WinAnsi-encoded: "—" is byte 0x97 and "·" byte 0xB7. Node's "latin1" decoder above
    // maps bytes to the same code points, so 0x97 reads back as U+0097.
    expect(pdf).toContain('(\u0097) Tj');
    expect(pdf).toContain('(P1 · 1.200 dari 10.002) Tj');
  });

  it('draws every table text in black, whatever the table sets itself', async () => {
    const pdf = await pdfText(REPORT);
    // jspdf-autotable's own body grey (80/255); only the footer is grey on purpose.
    expect(pdf).not.toContain('0.314 g');
  });

  it('repeats the header on every page of a long defect list', async () => {
    const long: ExportReport = {
      ...REPORT,
      defects: Array.from({ length: 120 }, (_, i) => ({ ...REPORT.defects[0]!, no: i + 1 })),
    };
    const pdf = await pdfText(long);
    const pages = Number(/Halaman 1 \/ (\d+)/.exec(pdf)?.[1]);
    expect(pages).toBeGreaterThan(1);
    expect(pdf.split(`(${EXPORT_TITLE})`).length - 1).toBe(pages);
  });
});
