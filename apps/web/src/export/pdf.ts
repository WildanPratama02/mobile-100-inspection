/**
 * EXPORT PDF (FR-12, doc 05 §8.5): an A4 report with the company mark and the title on every page header
 * (doc 05 §4a), then PO info, results, TOP 5 DEFECT, the photos (AC-12.2) and the full defect list.
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

/** Photos sit three in a row, each fitted in a 58 × 43 mm box with a two-line caption. */
const PHOTO_W = 58;
const PHOTO_H = 43;
const PHOTO_GAP = 4;
const CAPTION_H = 9;

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

  const table = (options: UserOptions) =>
    autoTable(doc, {
      theme: 'grid',
      margin: { top: CONTENT_TOP, left: MARGIN, right: MARGIN, bottom: 16 },
      styles: {
        font: 'helvetica',
        fontSize: 8.5,
        cellPadding: 1.6,
        textColor: INK,
        lineColor: LINE,
      },
      headStyles: { fillColor: HEAD_FILL, textColor: INK, fontStyle: 'bold' },
      didDrawPage: header,
      ...options,
    });

  const title = (text: string, y: number) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(INK);
    doc.text(text, MARGIN, y);
    return y + 2;
  };

  header();

  // PO info, inspector, Factory/Cell and export time, two pairs to a row.
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
      0: { fontStyle: 'bold', cellWidth: 30 },
      2: { fontStyle: 'bold', cellWidth: 30 },
    },
  });

  table({
    startY: tableEnd(doc) + 4,
    head: [report.results.map((r) => r.label)],
    body: [
      report.results.map((r) => (r.kind === 'count' ? formatCount(r.value) : formatRate(r.value))),
    ],
    styles: { fontSize: 9, cellPadding: 1.8, halign: 'center' },
    headStyles: { halign: 'center' },
  });

  const photoColumn = report.top5.some((row) => row.photo !== null);
  table({
    startY: title('TOP 5 DEFECT', tableEnd(doc) + 8),
    head: [['No', 'Defect', 'Klasifikasi', 'Area', 'Qty', ...(photoColumn ? ['Foto'] : [])]],
    body:
      report.top5.length === 0
        ? [[{ content: NO_DEFECT_TEXT, colSpan: photoColumn ? 6 : 5 }]]
        : report.top5.map((t) => [
            t.no,
            t.name,
            t.classification,
            t.areas,
            formatCount(t.qty),
            ...(photoColumn ? [t.photo ? 'Ada' : '-'] : []),
          ]),
    columnStyles: {
      0: { cellWidth: 9, halign: 'center' },
      2: { cellWidth: 20 },
      4: { cellWidth: 12, halign: 'right' },
      5: { cellWidth: 12, halign: 'center' },
    },
  });

  let y = tableEnd(doc) + 8;
  if (report.photos.length > 0) {
    const rowH = PHOTO_H + CAPTION_H + PHOTO_GAP;
    if (y + 4 + rowH > FOOTER_Y - 6) {
      doc.addPage();
      header();
      y = CONTENT_TOP + 4;
    }
    y = title('FOTO DEFECT', y) + 2;
    let x = MARGIN;
    for (const photo of report.photos) {
      if (x + PHOTO_W > PAGE_W - MARGIN + 0.5) {
        x = MARGIN;
        y += rowH;
      }
      if (y + rowH > FOOTER_Y - 6) {
        doc.addPage();
        header();
        x = MARGIN;
        y = CONTENT_TOP;
      }
      const bytes = assets.photos.get(photo.defectId);
      if (bytes) {
        const size = fit(doc, bytes, PHOTO_W, PHOTO_H);
        doc.addImage(bytes, 'JPEG', x + (PHOTO_W - size.w) / 2, y, size.w, size.h);
      }
      doc.setDrawColor(LINE);
      doc.rect(x, y, PHOTO_W, PHOTO_H);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(INK);
      const caption = photo.top5No === null ? photo.name : `${photo.top5No}. ${photo.name}`;
      const lines = doc.splitTextToSize(caption, PHOTO_W) as string[];
      doc.text(lines.slice(0, 2), x, y + PHOTO_H + 3.5);
      x += PHOTO_W + PHOTO_GAP;
    }
    y += rowH + 4;
  }

  if (y + 20 > FOOTER_Y - 6) {
    doc.addPage();
    header();
    y = CONTENT_TOP + 4;
  }
  table({
    startY: title('DAFTAR DEFECT', y),
    head: [['No', 'Tipe', 'Area', 'Sub Area', 'Family', 'Defect', 'Klasifikasi', 'Qty']],
    body:
      report.defects.length === 0
        ? [[{ content: NO_DEFECT_TEXT, colSpan: 8 }]]
        : report.defects.map((d) => [
            d.no,
            d.inspectionType,
            d.area,
            d.subArea,
            d.family,
            d.name,
            d.classification,
            formatCount(d.qty),
          ]),
    styles: { fontSize: 7.5, cellPadding: 1.4 },
    columnStyles: {
      0: { cellWidth: 8, halign: 'center' },
      1: { cellWidth: 16 },
      6: { cellWidth: 18 },
      7: { cellWidth: 10, halign: 'right' },
    },
  });

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
