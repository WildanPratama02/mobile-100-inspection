import { describe, expect, it } from 'vitest';
import { toPdf, type PdfAssets } from './pdf';
import { EXPORT_TITLE, type ExportReport } from './report';
import { JPEG, LOGO, ODD_PAIR, REPORT, REPORT_EMPTY, REPORT_LV1, SHARED_NAME } from './testReport';

function assets(report: ExportReport): PdfAssets {
  return { logo: LOGO, photos: new Map(report.photos.map((p) => [p.defectId, JPEG])) };
}

/** The PDF as text; jsPDF writes its content streams uncompressed, so drawn text is readable. */
async function pdfText(report: ExportReport): Promise<string> {
  const blob = toPdf(report, assets(report));
  expect(blob.type).toBe('application/pdf');
  return new TextDecoder('latin1').decode(await blob.arrayBuffer());
}

/**
 * Every string the PDF draws, in drawing order, joined by spaces: a text that autoTable or a caption wrapped over
 * several lines reads as one again (lines break at spaces).
 */
function drawn(pdf: string): string {
  return [...pdf.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
    .map(([, text]) => (text ?? '').replace(/\\(.)/g, '$1'))
    .join(' ');
}

/** How often `part` occurs in `text`. */
function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** The page count printed in the footer. */
function pagesOf(pdf: string): number {
  return Number(/Halaman 1 \/ (\d+)/.exec(pdf)?.[1]);
}

/** Images drawn, the company mark on every page included. */
function imagesDrawn(pdf: string): number {
  return pdf.match(/\/I\d+ Do/g)?.length ?? 0;
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
      'INSPECTION REWORK QTY',
      'Qty Defect',
      'Qty A-Grade',
      'Qty B-Grade',
      'REWORK AND APPROVED',
      'Defect Rate',
      'Pass Rate \\(RFT\\)',
    ]) {
      for (const word of label.split(' ')) expect(pdf).toContain(word);
    }
    // The two rework figures keep the uppercase English labels Home shows (CLAUDE.md, doc 05 §8.1).
    const text = drawn(pdf);
    expect(text).toContain('INSPECTION REWORK QTY');
    expect(text).toContain('REWORK AND APPROVED');
    expect(text).not.toContain('Inspection Rework Qty');
    expect(text).not.toContain('Rework and Approved');
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
    const text = drawn(pdf);
    // Names exactly as in the mapping, however the table wraps them.
    for (const d of REPORT.defects) expect(text).toContain(d.name);
    expect(text).toContain('VAMP, TOE BOX');
    expect(text).toContain('CRITICAL');
    // A six-column table: the sixth is the per-defect share of QTY INSPECTION.
    expect(pdf).toContain('(3,3%)');
  });

  it('includes every attached photo with its ranking number (AC-12.2)', async () => {
    const pdf = await pdfText(REPORT);
    const text = drawn(pdf);
    expect(pdf).toContain('FOTO DEFECT');
    expect(pdf).toContain('/DCTDecode');
    expect(text).toContain(`2. ${REPORT.defects[1]!.name}`);
    // Ranked sixth: still listed, so it keeps its number too.
    expect(text).toContain(`6. ${SHARED_NAME}`);
    // Four photos plus the mark on each page.
    expect(imagesDrawn(pdf)).toBe(REPORT.photos.length + pagesOf(pdf));
  });

  it('captions a photo with the full defect name, never cut (CLAUDE.md)', async () => {
    const pdf = await pdfText(REPORT);
    // About a hundred characters: more than two caption lines.
    expect(ODD_PAIR.length).toBeGreaterThan(90);
    expect(drawn(pdf)).toContain(`1. ${ODD_PAIR}`);

    // The caption takes three lines and its row grows, so the next row's photos start below its last line.
    const caption = /([\d.]+) TL\n[^\n]*\n[\d.]+ ([\d.]+) Td\n\(1\. ODD PAIR(?:[^\n]*\n)*?ET/.exec(
      pdf,
    );
    expect(caption).not.toBeNull();
    const lines = caption![0].match(/\) Tj/g)!.length;
    expect(lines).toBe(3);
    const lastBaseline = Number(caption![2]) - (lines - 1) * Number(caption![1]);
    // Photo boxes are 43 mm squares (121.89 pt); the company mark is smaller.
    const photoTops = [...pdf.matchAll(/q\n([\d.]+) 0 0 ([\d.]+) [\d.]+ ([\d.]+) cm\n\/I\d+ Do/g)]
      .filter(([, w]) => Math.abs(Number(w) - (43 * 72) / 25.4) < 0.01)
      .map(([, , h, y]) => Number(y) + Number(h));
    const rows = [...new Set(photoTops.map((top) => top.toFixed(2)))].map(Number);
    expect(rows).toHaveLength(2);
    // PDF y grows upwards: the second row's top edge sits at least 4 mm below the caption's last baseline.
    expect(lastBaseline - rows[1]!).toBeGreaterThan((4 * 72) / 25.4);
  });

  it('keeps D049 and D071 apart although they share a name (ADR-009)', async () => {
    const report: ExportReport = {
      ...REPORT,
      photos: REPORT.photos.filter((p) => p.defectId === 'D049' || p.defectId === 'D071'),
    };
    const pdf = await pdfText(report);
    const text = drawn(pdf);
    // Two table rows and two captions with the same name, numbered by their own rows.
    expect(occurrences(text, SHARED_NAME)).toBe(4);
    expect(text).toContain(`5. ${SHARED_NAME}`);
    expect(text).toContain(`6. ${SHARED_NAME}`);
    // Both photos are drawn: each is looked up by its DEFECT_ID, not by its name.
    const pages = pagesOf(pdf);
    expect(imagesDrawn(pdf)).toBe(2 + pages);
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
