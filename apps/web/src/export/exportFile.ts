/**
 * Builds an export file on the tablet (FR-12). The PDF and Excel writers are loaded on first use, from the
 * service worker's precache when offline (AC-12.4, NFR-04), so they don't slow the first start.
 */
import logoUrl from '../assets/parkland.png';
import type { ExportReport } from './report';

export type ExportFormat = 'pdf' | 'xlsx';

export interface ExportFile {
  name: string;
  blob: Blob;
}

async function bytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

async function loadLogo(): Promise<Uint8Array> {
  const response = await fetch(logoUrl);
  if (!response.ok) throw new Error(`Logo: HTTP ${response.status}`);
  return bytes(await response.blob());
}

export async function exportFile(format: ExportFormat, report: ExportReport): Promise<ExportFile> {
  const name = `${report.fileBase}.${format}`;
  if (format === 'xlsx') {
    const { toXlsx } = await import('./xlsx');
    return { name, blob: await toXlsx(report) };
  }
  const [{ toPdf }, logo, photos] = await Promise.all([
    import('./pdf'),
    loadLogo(),
    Promise.all(report.photos.map(async (p) => [p.defectId, await bytes(p.blob)] as const)),
  ]);
  return { name, blob: toPdf(report, { logo, photos: new Map(photos) }) };
}
