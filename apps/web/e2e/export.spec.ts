import { setQtyInspection } from './helpers';
// EXPORT PDF / EXPORT EXCEL on Home (T1.6: FR-12, AC-12.1 … AC-12.4). Both files describe the PO's
// sealed submission in the outbox, so each test SUBMIT POs first; the buttons are dead before that.
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { type Download, type Page } from '@playwright/test';
import { expect, test } from './fixtures';

// Quarter › Medial Quarter › Stitching (reference/mapping/mapping.json).
const FAMILY = 'Stitching';
const DEFECT = 'BROKEN STITCHING/LOOSE STITCHING/SKIPPED STITCHING/OPEN SEAM';

/** Today in WIB as `YYYYMMDD` (AC-12.3). */
function wibDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' })
    .format(new Date())
    .replaceAll('-', '');
}

test.beforeEach(async ({ page }) => {
  // Desktop Chromium has the save dialog, which a test can't answer; the tablet's Chrome downloads.
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  // Sealing is what these tests need; the API is never reached, so every submission stays Menunggu.
  await page.context().route('**/v1/submissions', (route) => route.abort('internetdisconnected'));
});

async function pick(page: Page, field: 'Nama' | 'Factory' | 'Cell', option: string) {
  await page.getByRole('button', { name: new RegExp(`^${field}`) }).click();
  await page
    .getByRole('dialog')
    .getByRole('option', { name: new RegExp(`^${option}`) })
    .click();
}

/** Logs in, adds PO 0903359388, records REWORK with one defect, END, and enters Qty Inspection 2 on Home. */
async function homeWithDefect(page: Page, name: string) {
  await page.goto('/');
  await pick(page, 'Nama', name);
  await pick(page, 'Factory', 'F 3');
  await pick(page, 'Cell', 'F3-10');
  await page.getByRole('button', { name: 'LOGIN' }).click();
  await page.getByRole('button', { name: 'Tambah PO' }).click();
  const dialog = page.getByRole('dialog', { name: 'Tambah PO' });
  await dialog.getByRole('button', { name: /^PO NUMBER/ }).click();
  await dialog.getByRole('searchbox').fill('0903359388');
  await dialog.getByRole('option', { name: /^0903359388/ }).click();
  await dialog.getByRole('button', { name: 'ADD TO PO LIST' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'ADD DEFECT' }).click();
  await page.getByRole('button', { name: 'REWORK' }).click();
  await page
    .getByRole('group', { name: 'Pilih area sepatu' })
    .getByRole('button', { name: 'QUARTER' })
    .click();
  const pane = page.getByRole('region', { name: 'Pilihan' });
  await pane.getByRole('button', { name: /^Medial Quarter/ }).click();
  await pane.getByRole('button', { name: new RegExp(`^${FAMILY}`) }).click();
  const defect = pane.getByRole('button', { name: new RegExp(`^${DEFECT}`) });
  await defect.click();
  await expect(defect).toContainText('1');
  await page.getByRole('button', { name: 'END INSPECTION' }).click();
  // Two pairs: PSI lv.2 taps NO DEFECT (ADR-021), PSI lv.1 enters Qty Inspection (ADR-019).
  const tapped = name === 'DEWI CONTOH';
  if (tapped) await page.getByRole('button', { name: 'NO DEFECT' }).click();
  await page
    .getByRole('navigation', { name: 'Navigasi input defect' })
    .getByRole('button', { name: 'HOME' })
    .click();
  if (!tapped) await setQtyInspection(page, 2);
  await expect(page.getByRole('region', { name: 'ALL DEFECT' })).toContainText(DEFECT);
}

/** SUBMIT PO through the confirm dialog (S8), so the outbox holds the sealed submission exports read. */
async function submitPo(page: Page) {
  await page.getByRole('button', { name: 'SUBMIT PO' }).click();
  await page
    .getByRole('dialog', { name: 'Submit PO' })
    .getByRole('button', { name: 'KIRIM' })
    .click();
  await expect(page.getByText('Tersimpan. Menunggu koneksi.')).toBeVisible();
}

/** The results box as shown, label → value. */
async function results(page: Page): Promise<string> {
  return (await page.getByRole('region', { name: 'Hasil' }).innerText()).replace(/\s+/g, ' ');
}

/** Taps an export button and returns the download it starts. */
async function exportVia(page: Page, button: 'EXPORT PDF' | 'EXPORT EXCEL'): Promise<Download> {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: button }).click();
  return download;
}

async function bytes(download: Download): Promise<Buffer> {
  return readFile(await download.path());
}

test('PSI lv.1 exports Excel and PDF of the sealed submission, which stays as it was (AC-12.1, AC-12.3, AC-12.4)', async ({
  page,
}) => {
  await homeWithDefect(page, 'ANDI CONTOH');
  await submitPo(page);
  // The sealed session became a fresh empty one; the files still describe Qty Inspection 2.
  const after = await results(page);
  // The inspection date is the WIB date of sealedAt, which is today here (AC-12.3).
  const base = `PSI_0903359388_${wibDate()}`;

  const xlsx = await exportVia(page, 'EXPORT EXCEL');
  expect(xlsx.suggestedFilename()).toBe(`${base}.xlsx`);
  await expect(page.getByText(`File dibuat: ${base}.xlsx`)).toBeVisible();
  const parts = unzipSync(new Uint8Array(await bytes(xlsx)));
  const workbook = Object.values(parts)
    .map((data) => strFromU8(data))
    .join('\n');
  // One sheet only, named PSI Report: no Daftar Defect, no Foto column (ADR-022).
  const book = strFromU8(parts['xl/workbook.xml']!);
  expect(book).toContain('name="PSI Report"');
  expect(book).not.toContain('Daftar Defect');
  expect(parts['xl/worksheets/sheet2.xml']).toBeUndefined();
  for (const text of [
    'PSI Inspection Report',
    'Part I: General Data',
    'PSI Name',
    'ANDI CONTOH (PSI lv.1)',
    'Part II: KPI Summary',
    'Inspected Qty (Including Rework)',
    'Rejected Order Qty',
    'Not Reworkable Defect %',
    'Total Approved Qty',
    'Part III: Daily Inspection Summary',
    'Qty Order',
    'Offered Lot Qty',
    'Rework and Approved',
    'Pairs Not Reworkable',
    'Balance Rework',
    'Defect Findings List',
    'Severity',
    '% of QTY INSPECTION',
    '0903359388',
    DEFECT,
  ]) {
    expect(workbook).toContain(text);
  }
  for (const stale of ['TOP 5 DEFECT', 'DICETAK', 'Foto', 'WIB']) {
    expect(workbook).not.toContain(stale);
  }

  const pdf = await exportVia(page, 'EXPORT PDF');
  expect(pdf.suggestedFilename()).toBe(`${base}.pdf`);
  await expect(page.getByText(`File dibuat: ${base}.pdf`)).toBeVisible();
  const text = (await bytes(pdf)).toString('latin1');
  expect(text.startsWith('%PDF-')).toBe(true);
  for (const value of [
    'PSI INSPECTION REPORT',
    'DATE INSPECTION',
    'DEFECT FINDINGS',
    '0903359388',
    'BROKEN STITCHING',
  ]) {
    expect(text).toContain(value);
  }
  for (const stale of ['DAFTAR DEFECT', 'DICETAK', 'TOP 5']) {
    expect(text).not.toContain(stale);
  }
  // No photos for PSI lv.1 (AC-10.6).
  expect(text).not.toContain('/DCTDecode');

  // AC-12.4: the exports read the outbox only, so Home stays as SUBMIT PO left it, also after a reload.
  expect(await results(page)).toBe(after);
  await page.reload();
  expect(await results(page)).toBe(after);
});

test('PSI lv.2 exports the sealed submission with its photo, and the PDF carries it (BR-04, AC-12.2)', async ({
  page,
}) => {
  await homeWithDefect(page, 'DEWI CONTOH');
  let downloads = 0;
  page.on('download', () => downloads++);

  // The photo check moved to SUBMIT PO: without it there is nothing to export, exports stay disabled.
  await page.getByRole('button', { name: 'SUBMIT PO' }).click();
  const blocked = page.getByRole('alertdialog', { name: 'Foto belum lengkap' });
  await expect(blocked).toContainText(DEFECT);
  await blocked.getByRole('button', { name: 'Lengkapi foto' }).click();
  await expect(blocked).toHaveCount(0);
  for (const button of ['EXPORT PDF', 'EXPORT EXCEL'] as const) {
    await expect(page.getByRole('button', { name: button })).toBeDisabled();
  }

  const jpeg = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const context = canvas.getContext('2d')!;
      context.fillStyle = 'teal';
      context.fillRect(0, 0, 640, 480);
      return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]!;
    }),
    'base64',
  );
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('region', { name: 'ALL DEFECT' })
    .getByRole('button', { name: 'Foto wajib' })
    .click();
  await (await chooser).setFiles({ name: 'camera.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(page.getByText('Foto tersimpan')).toBeVisible();
  expect(downloads).toBe(0);

  await submitPo(page);

  const pdf = await exportVia(page, 'EXPORT PDF');
  const text = (await bytes(pdf)).toString('latin1');
  expect(text).toContain('FOTO DEFECT');
  expect(text).toContain('DEFECT FINDINGS');
  expect(text).toContain('/DCTDecode');
  expect(text).toContain('BROKEN STITCHING');
  expect(text).toContain('DEWI CONTOH');
  expect(text).not.toContain('TOP 5');

  const xlsx = await exportVia(page, 'EXPORT EXCEL');
  const workbook = Object.values(unzipSync(new Uint8Array(await bytes(xlsx))))
    .map((data) => strFromU8(data))
    .join('\n');
  expect(workbook).toContain('DEWI CONTOH (PSI lv.2)');
  expect(workbook).toContain('PSI Report');
  expect(workbook).not.toContain('Foto');
});
