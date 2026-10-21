// EXPORT PDF / EXPORT EXCEL on Home (T1.6: FR-12, AC-12.1 … AC-12.4, doc 05 §8.5).
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
});

async function pick(page: Page, field: 'Nama' | 'Factory' | 'Cell', option: string) {
  await page.getByRole('button', { name: new RegExp(`^${field}`) }).click();
  await page
    .getByRole('dialog')
    .getByRole('option', { name: new RegExp(`^${option}`) })
    .click();
}

/** Logs in, adds PO 0903359388, records REWORK with one defect, END, one NO DEFECT, and returns to Home. */
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
  await page.getByRole('button', { name: 'NO DEFECT' }).click();
  await page
    .getByRole('navigation', { name: 'Navigasi input defect' })
    .getByRole('button', { name: 'HOME' })
    .click();
  await expect(page.getByRole('region', { name: 'TOP 5 DEFECT' })).toContainText(DEFECT);
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

test('PSI lv.1 exports Excel and PDF of the open session, which stays as it was (AC-12.1, AC-12.3, AC-12.4)', async ({
  page,
}) => {
  await homeWithDefect(page, 'ANDI CONTOH');
  const before = await results(page);
  const base = `M100_0903359388_${wibDate()}`;

  const xlsx = await exportVia(page, 'EXPORT EXCEL');
  expect(xlsx.suggestedFilename()).toBe(`${base}.xlsx`);
  await expect(page.getByText(`File dibuat: ${base}.xlsx`)).toBeVisible();
  const parts = unzipSync(new Uint8Array(await bytes(xlsx)));
  const workbook = Object.values(parts)
    .map((data) => strFromU8(data))
    .join('\n');
  expect(strFromU8(parts['xl/workbook.xml']!)).toContain('name="Daftar Defect"');
  for (const text of [
    '0903359388',
    'ANDI CONTOH (PSI lv.1)',
    'F3-10',
    'WIB',
    'Qty Inspection',
    'TOP 5 DEFECT',
    DEFECT,
    'Medial Quarter',
    'REWORK',
  ]) {
    expect(workbook).toContain(text);
  }

  const pdf = await exportVia(page, 'EXPORT PDF');
  expect(pdf.suggestedFilename()).toBe(`${base}.pdf`);
  await expect(page.getByText(`File dibuat: ${base}.pdf`)).toBeVisible();
  const text = (await bytes(pdf)).toString('latin1');
  expect(text.startsWith('%PDF-')).toBe(true);
  for (const value of [
    'MOBILE 100% INSPECTION',
    '0903359388',
    'BROKEN STITCHING',
    'DAFTAR DEFECT',
  ]) {
    expect(text).toContain(value);
  }
  // No photos for PSI lv.1 (AC-10.6).
  expect(text).not.toContain('/DCTDecode');

  // AC-12.4: same numbers, and the same after a reload from IndexedDB.
  expect(await results(page)).toBe(before);
  await page.reload();
  await expect(page.getByRole('region', { name: 'TOP 5 DEFECT' })).toContainText(DEFECT);
  expect(await results(page)).toBe(before);
});

test('PSI lv.2 exports only with every Top 5 photo, and the PDF carries it (BR-04, AC-12.2)', async ({
  page,
}) => {
  await homeWithDefect(page, 'DEWI CONTOH');
  let downloads = 0;
  page.on('download', () => downloads++);

  for (const button of ['EXPORT PDF', 'EXPORT EXCEL'] as const) {
    await page.getByRole('button', { name: button }).click();
    const blocked = page.getByRole('alertdialog', { name: 'Foto belum lengkap' });
    await expect(blocked).toContainText(DEFECT);
    await blocked.getByRole('button', { name: 'Lengkapi foto' }).click();
    await expect(blocked).toHaveCount(0);
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
    .getByRole('region', { name: 'TOP 5 DEFECT' })
    .getByRole('button', { name: 'Foto wajib' })
    .click();
  await (await chooser).setFiles({ name: 'camera.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(page.getByText('Foto tersimpan')).toBeVisible();
  expect(downloads).toBe(0);

  const pdf = await exportVia(page, 'EXPORT PDF');
  const text = (await bytes(pdf)).toString('latin1');
  expect(text).toContain('FOTO DEFECT');
  expect(text).toContain('/DCTDecode');
  expect(text).toContain('BROKEN STITCHING');

  const xlsx = await exportVia(page, 'EXPORT EXCEL');
  const workbook = Object.values(unzipSync(new Uint8Array(await bytes(xlsx))))
    .map((data) => strFromU8(data))
    .join('\n');
  expect(workbook).toContain('DEWI CONTOH (PSI lv.2)');
  expect(workbook).toContain('Foto');
});
