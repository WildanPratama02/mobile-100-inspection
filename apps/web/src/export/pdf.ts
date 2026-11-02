/**
 * EXPORT PDF (FR-12, doc 05 §8.5): an A4 report with the company mark and the title on every page header
 * (doc 05 §4a), then PO info and the inspection date, results, every defect finding and the photos
 * (AC-12.1, AC-12.2).
 *
 * The page is printed, so it is drawn in black and greys only; the screen's colour tokens don't apply.
 */
import { jsPDF } from 'jspdf';
import { autoTable, type RowInput, type UserOptions } from 'jspdf-autotable';
import { APP_NAME, formatCount, formatRate } from '@m100/shared';
import { EXPORT_TITLE, NO_DEFECT_TEXT, type ExportReport } from './report';

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 14;
/** The mark is 32 px high in the header (doc 05 §4a): 32 px at 96 dpi is 8.5 mm. */
const LOGO_H = 8.5;
const HEADER_BOTTOM = 22;
const CONTENT_TOP = 28;
const FOOTER_Y = PAGE_H - 8;

/**
 * Photos sit three in a row, each fitted in a 58 × 43 mm box. The caption below holds the full defect name as in
 * the mapping, on as many lines as it needs; a row is as high as its longest caption (at least two lines).
 */
const PHOTO_W = 58;
const PHOTO_H = 43;
const PHOTO_GAP = 4;
const PER_ROW = 3;
const CAPTION_PT = 7.5;
/** The first caption baseline below the photo box, and the space kept under the last line. */
const CAPTION_TOP = 3.5;
const CAPTION_BOTTOM = 2.5;
/** jsPDF's line height for a text array: the font size × its line height factor (1.15), in mm. */
const CAPTION_LINE = (CAPTION_PT * 1.15 * 25.4) / 72;

const INK = 0;
const MUTED = 90;
const LINE = 200;
const HEAD_FILL = 230;

/** The PSI's photos as JPEG bytes, and the company mark as PNG bytes. */
export interface PdfAssets {
  logo: Uint8Array;
  photos: ReadonlyMap<string, Uint8Array>;
}

/** Where the table `autoTable` drew last ends; jspdf-autotable 5 doesn't type this property. */
function tableEnd(doc: jsPDF): number {
  return (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
}

function fit(doc: jsPDF, image: Uint8Array, maxW: number, maxH: number) {
  const { width, height } = doc.getImageProperties(image);
  const k = Math.min(maxW / width, maxH / height);
  return { w: width * k, h: height * k };
}

export function toPdf(report: ExportReport, assets: PdfAssets): Blob {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  doc.setProperties({ title: report.fileBase, creator: APP_NAME });
  const logo = fit(doc, assets.logo, 40, LOGO_H);

  // Once per page: autoTable calls this for every table that touches a page.
  const headed = new Set<number>();
  const header = () => {
    const page = doc.getCurrentPageInfo().pageNumber;
    if (headed.has(page)) return;
    headed.add(page);
    doc.addImage(assets.logo, 'PNG', MARGIN, 9, logo.w, logo.h);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(INK);
    doc.text(EXPORT_TITLE, MARGIN + logo.w + 4, 15.5);
    doc.setDrawColor(LINE);
    doc.line(MARGIN, HEADER_BOTTOM, PAGE_W - MARGIN, HEADER_BOTTOM);
  };

  // A table's own styles add to these; autoTable would replace the whole object otherwise.
  const table = ({ styles, headStyles, ...options }: UserOptions) =>
    autoTable(doc, {
      theme: 'grid',
      margin: { top: CONTENT_TOP, left: MARGIN, right: MARGIN, bottom: 16 },
      didDrawPage: header,
      ...options,
      styles: {
        font: 'helvetica',
        fontSize: 8.5,
        cellPadding: 1.6,
        textColor: INK,
        lineColor: LINE,
        ...styles,
      },
      headStyles: { fillColor: HEAD_FILL, textColor: INK, fontStyle: 'bold', ...headStyles },
    });

  const title = (text: string, y: number) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(INK);
    doc.text(text, MARGIN, y);
    return y + 2;
  };

  header();

  // PO info, inspector, Factory/Cell and the inspection date, two pairs to a row (AC-12.3).
  const info: RowInput[] = [];
  for (let i = 0; i < report.info.length; i += 2) {
    const [a, b] = [report.info[i]!, report.info[i + 1]];
    info.push([a[0], a[1], b?.[0] ?? '', b?.[1] ?? '']);
  }
  table({
    startY: CONTENT_TOP,
    theme: 'plain',
    body: info,
    styles: { fontSize: 9, cellPadding: 1.2, textColor: INK },
    columnStyles: {
      // Wide enough for the longest label, `DATE INSPECTION`, to stay on one line in either label column
      // (it is the third pair without a partial row and the fourth with one).
      0: { fontStyle: 'bold', cellWidth: 36 },
      2: { fontStyle: 'bold', cellWidth: 34 },
    },
  });

  // Nine figures, including both rework values (ADR-022 decision 7).
  table({
    startY: tableEnd(doc) + 4,
    head: [report.results.map((r) => r.label)],
    body: [
      report.results.map((r) => (r.kind === 'count' ? formatCount(r.value) : formatRate(r.value))),
    ],
    styles: { fontSize: 9, cellPadding: 1.8, halign: 'center' },
    headStyles: { halign: 'center' },
  });

  // Every defect in the findings, not just the first five (ADR-022).
  table({
    startY: title('DEFECT FINDINGS', tableEnd(doc) + 8),
    head: [['No', 'Defect', 'Severity', 'Area', 'Qty', '% of QTY INSPECTION']],
    body:
      report.defects.length === 0
        ? [[{ content: NO_DEFECT_TEXT, colSpan: 6 }]]
        : report.defects.map((d) => [
            d.no,
            d.name,
            d.classification,
            d.areas,
            formatCount(d.qty),
            formatRate(d.rate),
          ]),
    columnStyles: {
      0: { cellWidth: 9, halign: 'center' },
      2: { cellWidth: 20 },
      4: { cellWidth: 14, halign: 'right' },
      5: { cellWidth: 32, halign: 'right' },
    },
  });

  let y = tableEnd(doc) + 8;
  if (report.photos.length > 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(CAPTION_PT);
    // Every listed defect has a number, so a photo always names its row (AC-10.4); the name is never cut.
    const captioned = report.photos.map((photo) => ({
      photo,
      lines: doc.splitTextToSize(`${photo.no}. ${photo.name}`, PHOTO_W) as string[],
    }));
    const rows: (typeof captioned)[] = [];
    for (let i = 0; i < captioned.length; i += PER_ROW) rows.push(captioned.slice(i, i + PER_ROW));
    const heightOf = (row: typeof captioned) => {
      const lines = Math.max(2, ...row.map((c) => c.lines.length));
      return PHOTO_H + CAPTION_TOP + (lines - 1) * CAPTION_LINE + CAPTION_BOTTOM + PHOTO_GAP;
    };

    if (y + 4 + heightOf(rows[0]!) > FOOTER_Y - 6) {
      doc.addPage();
      header();
      y = CONTENT_TOP + 4;
    }
    y = title('FOTO DEFECT', y) + 2;
    for (const row of rows) {
      const rowH = heightOf(row);
      if (y + rowH > FOOTER_Y - 6) {
        doc.addPage();
        header();
        y = CONTENT_TOP;
      }
      let x = MARGIN;
      for (const { photo, lines } of row) {
        const bytes = assets.photos.get(photo.defectId);
        if (bytes) {
          const size = fit(doc, bytes, PHOTO_W, PHOTO_H);
          doc.addImage(bytes, 'JPEG', x + (PHOTO_W - size.w) / 2, y, size.w, size.h);
        }
        doc.setDrawColor(LINE);
        doc.rect(x, y, PHOTO_W, PHOTO_H);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(CAPTION_PT);
        doc.setTextColor(INK);
        doc.text(lines, x, y + PHOTO_H + CAPTION_TOP);
        x += PHOTO_W + PHOTO_GAP;
      }
      y += rowH;
    }
  }

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(MUTED);
    doc.text(report.fileBase, MARGIN, FOOTER_Y);
    doc.text(`Halaman ${i} / ${pages}`, PAGE_W - MARGIN, FOOTER_Y, { align: 'right' });
  }

  return doc.output('blob');
}
