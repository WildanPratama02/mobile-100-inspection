// Photos on Top 5 defects: camera, resize, viewer, GANTI FOTO, HAPUS (T1.5: FR-10, AC-10.1 … AC-10.6).
import { expect, test, type Page } from '@playwright/test';
import { undersized } from './tap';

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 915, height: 412 },
  { width: 800, height: 1280 },
];

// Quarter › Medial Quarter › Stitching (reference/mapping/mapping.json).
const FAMILY = 'Stitching';
const DEFECT = 'BROKEN STITCHING/LOOSE STITCHING/SKIPPED STITCHING/OPEN SEAM';

async function pick(page: Page, field: 'Nama' | 'Factory' | 'Cell', option: string) {
  await page.getByRole('button', { name: new RegExp(`^${field}`) }).click();
  await page
    .getByRole('dialog')
    .getByRole('option', { name: new RegExp(`^${option}`) })
    .click();
}

/** Logs in, adds PO 0903359388, records one REWORK defect and returns to Home. */
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
  await page
    .getByRole('navigation', { name: 'Navigasi input defect' })
    .getByRole('button', { name: 'HOME' })
    .click();
  await expect(page.getByRole('region', { name: 'TOP 5 DEFECT' })).toContainText(DEFECT);
}

/**
 * A camera-sized JPEG made in the page. A plain gradient keeps the suite light; the quality steps for a
 * photo that encodes above 1 MB are unit-tested (`encodeWithin`).
 */
async function cameraJpeg(page: Page, width: number, height: number): Promise<Buffer> {
  const base64 = await page.evaluate(
    ([w, h]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext('2d')!;
      const gradient = context.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, 'navy');
      gradient.addColorStop(1, 'orange');
      context.fillStyle = gradient;
      context.fillRect(0, 0, w, h);
      return canvas.toDataURL('image/jpeg', 0.95).split(',')[1]!;
    },
    [width, height] as const,
  );
  return Buffer.from(base64, 'base64');
}

/** Taps a control that opens the camera and hands it a file, as the system camera would. */
async function shoot(page: Page, open: () => Promise<void>, jpeg: Buffer) {
  const chooser = page.waitForEvent('filechooser');
  await open();
  await (await chooser).setFiles({ name: 'camera.jpg', mimeType: 'image/jpeg', buffer: jpeg });
}

interface StoredPhoto {
  defectId: string;
  size: number;
  type: string;
  head: number[];
  width: number;
  height: number;
  sha256: string;
}

/** The photos as stored in IndexedDB, decoded again to read their size. */
function storedPhotos(page: Page): Promise<StoredPhoto[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('m100');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
    const rows = await new Promise<Array<{ defectId: string; blob: Blob; sha256: string }>>(
      (resolve, reject) => {
        const request = db.transaction('photos').objectStore('photos').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      },
    );
    db.close();
    return Promise.all(
      rows.map(async (row) => {
        const bitmap = await createImageBitmap(row.blob);
        const head = Array.from(new Uint8Array(await row.blob.slice(0, 3).arrayBuffer()));
        return {
          defectId: row.defectId,
          size: row.blob.size,
          type: row.blob.type,
          head,
          width: bitmap.width,
          height: bitmap.height,
          sha256: row.sha256,
        };
      }),
    );
  });
}

const top5 = (page: Page) => page.getByRole('region', { name: 'TOP 5 DEFECT' });
const required = (page: Page) => top5(page).getByRole('button', { name: 'Foto wajib' });
const thumbnail = (page: Page) => top5(page).getByRole('button', { name: `Lihat foto ${DEFECT}` });

test('PSI lv.2 takes, keeps, replaces and removes a Top 5 photo (AC-10.1 … AC-10.5)', async ({
  page,
}) => {
  await homeWithDefect(page, 'DEWI CONTOH');
  await expect(top5(page).getByText('Foto wajib', { exact: true })).toBeVisible();
  await expect(page.getByText('1 foto belum ada.')).toBeVisible();

  // S7a: a 3000 × 2000 camera photo is stored at 960 px, as JPEG of at most 1 MB (AC-10.1).
  const landscape = await cameraJpeg(page, 3000, 2000);
  await shoot(page, () => required(page).click(), landscape);
  await expect(page.getByText('Foto tersimpan')).toBeVisible();
  await expect(thumbnail(page)).toBeVisible();
  await expect(page.getByText('1 foto belum ada.')).toHaveCount(0);

  const [first, ...more] = await storedPhotos(page);
  expect(more).toEqual([]);
  expect(first).toMatchObject({
    type: 'image/jpeg',
    head: [0xff, 0xd8, 0xff],
    width: 960,
    height: 640,
  });
  expect(first!.size).toBeLessThanOrEqual(1_000_000);
  expect(first!.sha256).toMatch(/^[0-9a-f]{64}$/);

  // AC-10.2: the photo stays with the session across a reload.
  await page.reload();
  await expect(thumbnail(page)).toBeVisible();
  await expect(thumbnail(page).locator('img')).toHaveAttribute('src', /^blob:/);

  // S7b: the photo large; GANTI FOTO replaces it, so there is still one (AC-10.5).
  await thumbnail(page).click();
  const view = page.getByRole('dialog', { name: 'Foto defect' });
  await expect(view).toContainText(DEFECT);
  await expect(view.getByRole('img', { name: `Foto defect ${DEFECT}` })).toBeVisible();
  const portrait = await cameraJpeg(page, 1500, 3000);
  await shoot(page, () => view.getByRole('button', { name: 'GANTI FOTO' }).click(), portrait);
  await expect(page.getByText('Foto tersimpan')).toBeVisible();
  await expect(view).toHaveCount(0);
  const replaced = await storedPhotos(page);
  expect(replaced).toHaveLength(1);
  expect(replaced[0]).toMatchObject({ width: 480, height: 960 });
  expect(replaced[0]!.sha256).not.toBe(first!.sha256);

  // HAPUS asks nothing more and returns the row to "Foto wajib" (U11).
  await thumbnail(page).click();
  await view.getByRole('button', { name: 'HAPUS' }).click();
  await expect(page.getByText('Foto dihapus')).toBeVisible();
  await expect(required(page)).toBeVisible();
  expect(await storedPhotos(page)).toEqual([]);
});

test('a cancelled camera changes nothing', async ({ page }) => {
  await homeWithDefect(page, 'DEWI CONTOH');
  const chooser = page.waitForEvent('filechooser');
  await required(page).click();
  await (await chooser).setFiles([]);
  await expect(required(page)).toBeVisible();
  await expect(page.getByText('Foto tersimpan')).toHaveCount(0);
  expect(await storedPhotos(page)).toEqual([]);
});

test('PSI lv.1 has no photo control and no camera (AC-10.6)', async ({ page }) => {
  await homeWithDefect(page, 'ANDI CONTOH');
  await expect(top5(page).locator('.m100-t5--nophoto')).toHaveCount(1);
  await expect(top5(page).getByRole('button')).toHaveCount(0);
  await expect(page.getByText('Foto wajib')).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
});

for (const viewport of VIEWPORTS) {
  test(`photo controls and the photo view are at least 44 × 44 px at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await homeWithDefect(page, 'DEWI CONTOH');
    expect(await undersized(page)).toEqual([]);
    await shoot(page, () => required(page).click(), await cameraJpeg(page, 1200, 900));
    await expect(thumbnail(page)).toBeVisible();
    expect(await undersized(page)).toEqual([]);
    await thumbnail(page).click();
    await expect(page.getByRole('dialog', { name: 'Foto defect' })).toBeVisible();
    expect(await undersized(page)).toEqual([]);
  });
}
