// SUBMIT PO, local half: checks, confirmation, sealing into the outbox, waiting count and gear list
// (T1.7: FR-11 steps 1–3, BR-04, AC-11.3; doc 05 §13, §14).
import { type Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { undersized } from './tap';

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 915, height: 412 },
  { width: 800, height: 1280 },
];

const PO = '0903359388';
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

async function login(page: Page, name: string) {
  await pick(page, 'Nama', name);
  await pick(page, 'Factory', 'F 3');
  await pick(page, 'Cell', 'F3-10');
  await page.getByRole('button', { name: 'LOGIN' }).click();
}

/** Logs in and adds PO 0903359388 with an empty session. */
async function homeWithPo(page: Page, name: string) {
  await page.goto('/');
  await login(page, name);
  await page.getByRole('button', { name: 'Tambah PO' }).click();
  const dialog = page.getByRole('dialog', { name: 'Tambah PO' });
  await dialog.getByRole('button', { name: /^PO NUMBER/ }).click();
  await dialog.getByRole('searchbox').fill(PO);
  await dialog.getByRole('option', { name: new RegExp(`^${PO}`) }).click();
  await dialog.getByRole('button', { name: 'ADD TO PO LIST' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/** On the Defect screen: starts REWORK and records one defect; the inspection stays active. */
async function reworkWithDefect(page: Page) {
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
}

async function goHome(page: Page) {
  await page
    .getByRole('navigation', { name: 'Navigasi input defect' })
    .getByRole('button', { name: 'HOME' })
    .click();
}

/** One ended REWORK with one defect, back on Home. */
async function homeWithEndedInspection(page: Page, name: string) {
  await homeWithPo(page, name);
  await page.getByRole('button', { name: 'ADD DEFECT' }).click();
  await reworkWithDefect(page);
  await page.getByRole('button', { name: 'END INSPECTION' }).click();
  await goHome(page);
}

/** A camera photo as the system camera hands it over. */
async function shootTop5(page: Page) {
  const jpeg = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 900;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'teal';
    context.fillRect(0, 0, 1200, 900);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]!;
  });
  const chooser = page.waitForEvent('filechooser');
  await top5(page).getByRole('button', { name: 'Foto wajib' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'camera.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(jpeg, 'base64'),
  });
  await expect(page.getByText('Foto tersimpan')).toBeVisible();
}

interface Stored {
  outbox: Array<{
    po: string;
    state: string;
    authorUsername: string;
    payloadJson: string;
    payloadSha256: string;
    /** SHA-256 of `payloadJson` as UTF-8, computed again in the page. */
    rehashed: string;
  }>;
  outboxPhotos: string[];
  photos: number;
  sessions: string[];
}

/** What sealing left in IndexedDB. */
function stored(page: Page): Promise<Stored> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('m100');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
    const all = <T>(table: string) =>
      new Promise<T[]>((resolve, reject) => {
        const request = db.transaction(table).objectStore(table).getAll();
        request.onsuccess = () => resolve(request.result as T[]);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      });
    const hex = async (text: string) => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    };
    const outbox = await all<Omit<Stored['outbox'][number], 'rehashed'>>('outbox');
    const result = {
      outbox: await Promise.all(
        outbox.map(async (o) => ({
          po: o.po,
          state: o.state,
          authorUsername: o.authorUsername,
          payloadJson: o.payloadJson,
          payloadSha256: o.payloadSha256,
          rehashed: await hex(o.payloadJson),
        })),
      ),
      outboxPhotos: (await all<{ defectId: string }>('outboxPhotos')).map((p) => p.defectId),
      photos: (await all('photos')).length,
      sessions: (await all<{ status: string }>('sessions')).map((s) => s.status).sort(),
    };
    db.close();
    return result;
  });
}

const top5 = (page: Page) => page.getByRole('region', { name: 'TOP 5 DEFECT' });
const submitPo = (page: Page) => page.getByRole('button', { name: 'SUBMIT PO' }).click();
const confirm = (page: Page) => page.getByRole('dialog', { name: 'Submit PO' });
const badge = (page: Page) => page.getByLabel(/pengiriman menunggu/);
const results = (page: Page) => page.getByRole('region', { name: 'Hasil' });

async function openOutbox(page: Page) {
  await page.getByRole('button', { name: 'Pengaturan' }).click();
  return page
    .getByRole('dialog', { name: 'Pengaturan' })
    .getByRole('region', { name: 'Pengiriman' });
}

test('PSI lv.2: checks in order, confirmation, KIRIM into the outbox, kept after a reload', async ({
  page,
}) => {
  await homeWithPo(page, 'DEWI CONTOH');

  // Qty Inspection is 0.
  await submitPo(page);
  const empty = page.getByRole('alertdialog', { name: 'Belum ada inspeksi' });
  await expect(empty).toContainText('Belum ada inspeksi untuk PO ini. Mulai dari ADD DEFECT.');
  await empty.getByRole('button', { name: 'Mengerti' }).click();

  // An inspection is active: checked before the missing photo; Ke ADD DEFECT opens S6.
  await page.getByRole('button', { name: 'ADD DEFECT' }).click();
  await reworkWithDefect(page);
  await goHome(page);
  await submitPo(page);
  const active = page.getByRole('alertdialog', { name: 'Inspeksi masih berjalan' });
  await expect(active).toContainText('Selesaikan inspeksi dulu (END INSPECTION).');
  await active.getByRole('button', { name: 'Ke ADD DEFECT' }).click();
  await page.getByRole('button', { name: 'END INSPECTION' }).click();
  await goHome(page);

  // BR-04: the Top 5 defect has no photo.
  await submitPo(page);
  const photos = page.getByRole('alertdialog', { name: 'Foto belum lengkap' });
  await expect(photos.getByRole('listitem')).toHaveText([DEFECT]);
  await photos.getByRole('button', { name: 'Lengkapi foto' }).click();
  await shootTop5(page);

  // The confirmation; BATAL changes nothing.
  await submitPo(page);
  await expect(confirm(page)).toContainText(PO);
  await expect(confirm(page)).toContainText(/Qty Inspection\s*1/);
  await expect(confirm(page)).toContainText(/Qty Defect\s*1/);
  await expect(confirm(page)).toContainText(/Defect Rate\s*100,0%/);
  await expect(confirm(page)).toContainText(/Pass Rate \(RFT\)\s*0,0%/);
  await expect(confirm(page)).toContainText(/Foto\s*1/);
  await confirm(page).getByRole('button', { name: 'BATAL' }).click();
  expect((await stored(page)).outbox).toEqual([]);

  // KIRIM: sealed, Home shows the new empty session and the waiting count.
  await submitPo(page);
  await confirm(page).getByRole('button', { name: 'KIRIM' }).click();
  await expect(page.getByText('Tersimpan. Menunggu koneksi.')).toBeVisible();
  await expect(badge(page)).toHaveText('1');
  await expect(results(page)).toContainText(/Qty Inspection\s*0/);
  await expect(top5(page)).toContainText('Belum ada defect');

  const sealed = await stored(page);
  expect(sealed.outbox).toHaveLength(1);
  const [item] = sealed.outbox;
  expect(item).toMatchObject({ po: PO, state: 'waiting', authorUsername: 'DEWI CONTOH' });
  // The stored string and its hash agree (doc 04 §4.3).
  expect(item!.payloadSha256).toBe(item!.rehashed);
  const payload = JSON.parse(item!.payloadJson) as {
    sealedAt: string;
    counts: object;
    findings: Array<{ defectId: string; qty: number }>;
    photos: Array<{ defectId: string; part: string }>;
  };
  expect(payload.sealedAt).toMatch(/\+07:00$/);
  expect(payload.counts).toEqual({ rework: 1, bGrade: 0, noDefect: 0 });
  expect(payload.findings).toHaveLength(1);
  expect(payload.photos.map((p) => p.part)).toEqual([`photo_${payload.findings[0]!.defectId}`]);
  expect(sealed.outboxPhotos).toEqual([payload.findings[0]!.defectId]);
  expect(sealed.photos).toBe(0);
  expect(sealed.sessions).toEqual(['closed', 'open']);

  const outbox = await openOutbox(page);
  await expect(outbox.getByRole('listitem')).toHaveCount(1);
  await expect(outbox.getByRole('listitem')).toContainText(PO);
  await expect(outbox.getByRole('listitem')).toContainText(/\d{2}:\d{2}/);
  await expect(outbox.getByRole('listitem')).toContainText('Menunggu');

  // Everything survives closing and reopening the app (AC-11.2).
  await page.reload();
  await expect(badge(page)).toHaveText('1');
  await expect(results(page)).toContainText(/Qty Inspection\s*0/);
  await expect((await openOutbox(page)).getByRole('listitem')).toContainText('Menunggu');
  expect(await stored(page)).toEqual(sealed);
});

test('PSI lv.1 submits without a photo step (AC-10.6)', async ({ page }) => {
  await homeWithEndedInspection(page, 'ANDI CONTOH');
  await submitPo(page);
  await expect(confirm(page)).toBeVisible();
  await expect(confirm(page)).not.toContainText('Foto');
  await confirm(page).getByRole('button', { name: 'KIRIM' }).click();
  await expect(badge(page)).toHaveText('1');
  const sealed = await stored(page);
  expect(sealed.outboxPhotos).toEqual([]);
  expect((JSON.parse(sealed.outbox[0]!.payloadJson) as { photos: unknown[] }).photos).toEqual([]);
});

test('each PSI sees only their own submissions on a shared tablet (U14)', async ({ page }) => {
  await homeWithEndedInspection(page, 'ANDI CONTOH');
  await submitPo(page);
  await confirm(page).getByRole('button', { name: 'KIRIM' }).click();
  await expect(badge(page)).toHaveText('1');

  await page.getByRole('button', { name: 'Pengaturan' }).click();
  await page
    .getByRole('dialog', { name: 'Pengaturan' })
    .getByRole('button', { name: 'LOGOUT' })
    .click();
  await login(page, 'DEWI CONTOH');
  await expect(page.getByRole('button', { name: 'SUBMIT PO' })).toBeVisible();
  await expect(badge(page)).toHaveCount(0);
  const outbox = await openOutbox(page);
  await expect(outbox).toContainText('Tidak ada pengiriman.');
  await expect(outbox.getByRole('listitem')).toHaveCount(0);
});

for (const viewport of VIEWPORTS) {
  test(`SUBMIT PO dialogs and the outbox are at least 44 × 44 px at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await homeWithEndedInspection(page, 'DEWI CONTOH');

    await submitPo(page);
    await expect(page.getByRole('alertdialog', { name: 'Foto belum lengkap' })).toBeVisible();
    expect(await undersized(page)).toEqual([]);
    await page.getByRole('button', { name: 'Lengkapi foto' }).click();
    await shootTop5(page);

    await submitPo(page);
    await expect(confirm(page)).toBeVisible();
    expect(await undersized(page)).toEqual([]);
    // KIRIM is on screen without scrolling the dialog.
    await expect(confirm(page).getByRole('button', { name: 'KIRIM' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await confirm(page).getByRole('button', { name: 'KIRIM' }).click();
    await expect(badge(page)).toHaveText('1');
    expect(await undersized(page)).toEqual([]);

    const outbox = await openOutbox(page);
    await expect(outbox.getByRole('listitem')).toHaveCount(1);
    expect(await undersized(page)).toEqual([]);
  });
}
