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
  it('is a PDF with the title, PO info, inspection date and nine results (AC-12.1)', async () => {
    const pdf = await pdfText(REPORT);
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(pdf).toContain(`(${EXPORT_TITLE})`);
    // PDF strings escape their parentheses.
    for (const value of ['0903359388', 'RUNNER CONTOH 1', 'DEWI CONTOH \\(PSI lv.2\\)', 'F3-10']) {
      expect(pdf).toContain(value);
    }
    expect(pdf).toContain('DATE INSPECTION');
    expect(pdf).toContain('(19 Okt 2026)');
    expect(pdf).not.toContain('DICETAK');
    // Nine headings; autoTable wraps each multi-word label to its column, so the words are separate strings.
    for (const label of [
      'Qty PO Order',
      'Qty Inspection',
      'Inspection Rework Qty',
      'Qty Defect',
      'Qty A-Grade',
      'Qty B-Grade',
      'Rework and Approved',
      'Defect Rate',
      'Pass Rate \\(RFT\\)',
    ]) {
      for (const word of label.split(' ')) expect(pdf).toContain(word);
    }
    expect(pdf).toContain('(10.002)');
    expect(pdf).toContain('23,3%');
    expect(pdf).toContain('76,7%');
    expect(pdf).toContain('Halaman 1 / ');
  });

  it('lists every defect in DEFECT FINDINGS, not only five (ADR-022)', async () => {
    const pdf = await pdfText(REPORT);
    expect(pdf).toContain('DEFECT FINDINGS');
    expect(pdf).not.toContain('TOP 5');
    expect(pdf).not.toContain('DAFTAR DEFECT');
    // autoTable wraps the long heading to the column width.
    expect(pdf).toContain('% of QTY');
    expect(pdf).toContain('INSPECTION');
    for (const value of [
      'BOND GAP',
      'WRINKLE',
      'PAINT MARK',
      'PAINT SMEAR',
      'GLUE STAIN',
      'STAIN OUTSIDE',
      'VAMP, TOE BOX',
      'CRITICAL',
    ]) {
      expect(pdf).toContain(value);
    }
    // A six-column table: the sixth is the per-defect share of QTY INSPECTION.
    expect(pdf).toContain('(3,3%)');
  });

  it('includes every attached photo with its ranking number (AC-12.2)', async () => {
    const pdf = await pdfText(REPORT);
    expect(pdf).toContain('FOTO DEFECT');
    expect(pdf).toContain('/DCTDecode');
    expect(pdf).toContain('(1. BOND GAP)');
    expect(pdf).toContain('(2. WRINKLE)');
    // Ranked sixth: still listed, so it keeps its number too.
    expect(pdf).toContain('(6. STAIN OUTSIDE)');
  });

  it('has the logo but no photo section for PSI lv.1', async () => {
    const pdf = await pdfText(REPORT_LV1);
    expect(pdf).toContain('/Subtype /Image');
    expect(pdf).not.toContain('/DCTDecode');
    expect(pdf).not.toContain('FOTO DEFECT');
  });

  it('an empty session shows "Belum ada defect." and 0,0% for the rates (doc 05 §8.5)', async () => {
    const pdf = await pdfText(REPORT_EMPTY);
    expect(pdf).toContain('Belum ada defect.');
    // Every figure is printed, none is "—" any more (31 Oct 2026).
    expect(pdf).toContain('(0,0%)');
    expect(pdf).not.toContain('(\u0097) Tj');
    // Helvetica is WinAnsi-encoded: "·" is byte 0xB7; Node's "latin1" decoder above maps it to the same point.
    expect(pdf).toContain('(P1 · 1.200 dari 10.002) Tj');
  });

  it('draws every table text in black, whatever the table sets itself', async () => {
    const pdf = await pdfText(REPORT);
    // jspdf-autotable's own body grey (80/255); only the footer is grey on purpose.
    expect(pdf).not.toContain('0.314 g');
  });

  it('repeats the header on every page of a long photo section', async () => {
    const long: ExportReport = {
      ...REPORT,
      photos: Array.from({ length: 30 }, (_, i) => ({
        ...REPORT.photos[2]!,
        defectId: `D${String(i + 10).padStart(3, '0')}`,
      })),
    };
    const pdf = await pdfText(long);
    const pages = Number(/Halaman 1 \/ (\d+)/.exec(pdf)?.[1]);
    expect(pages).toBeGreaterThan(1);
    expect(pdf.split(`(${EXPORT_TITLE})`).length - 1).toBe(pages);
  });
});
