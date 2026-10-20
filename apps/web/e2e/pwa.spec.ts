// The built app as a PWA: installable, and the whole Phase 1 flow with the network off after the first load
// (T1.8; NFR-04, doc 03 §4.1, doc 05 §18). Runs against `vite preview` (project "pwa" in playwright.config.ts).
import { expect, test, type Page } from '@playwright/test';
import {
  addPo,
  bar,
  expectResults,
  expectTop5,
  login,
  logout,
  openFamily,
  outbox,
  choice,
  top5,
} from './helpers';

const PO = '0903359388';
const DEFECT = 'BROKEN STITCHING/LOOSE STITCHING/SKIPPED STITCHING/OPEN SEAM';

test.beforeEach(async ({ page }) => {
  // Desktop Chromium has the save dialog, which a test can't answer; the tablet's Chrome downloads.
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
});

/** First online launch: waits until the service worker has precached the app shell and is active. */
async function firstLaunch(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}

test('is installable: manifest, icons and an active service worker', async ({ page }) => {
  await firstLaunch(page);
  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  expect(installabilityErrors).toEqual([]);

  const { errors, data } = await cdp.send('Page.getAppManifest');
  expect(errors).toEqual([]);
  expect(JSON.parse(data!)).toMatchObject({
    name: 'Mobile 100% Inspection',
    short_name: 'M100',
    display: 'standalone',
    orientation: 'landscape',
    start_url: '/',
  });
});

test('after the first load, inspection, photos, results, export and SUBMIT PO work offline (NFR-04)', async ({
  page,
  context,
}) => {
  await firstLaunch(page);
  // Login and PO search need the network by design (U4, AC-13.3); everything after them must not.
  await login(page, 'DEWI CONTOH');
  await addPo(page, PO);

  await context.setOffline(true);
  const failed: string[] = [];
  page.on('requestfailed', (request) => failed.push(request.url()));
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'PO LIST' })).toContainText(PO);

  // Self-hosted fonts and the logo come from the precache.
  const assets = await page.evaluate(async () => {
    await document.fonts.ready;
    const logo = document.querySelector<HTMLImageElement>('img');
    return {
      fonts: ['Barlow Condensed', 'Barlow Semi Condensed', 'IBM Plex Mono'].filter(
        (family) =>
          ![...document.fonts].some((f) => f.family.includes(family) && f.status === 'loaded'),
      ),
      logo: logo?.complete && logo.naturalWidth > 0,
    };
  });
  expect(assets.fonts, 'fonts not loaded offline').toEqual([]);
  expect(assets.logo).toBe(true);

  // Defect screen (S6): REWORK with two defects; the shoe photo is precached too.
  await page.getByRole('button', { name: 'ADD DEFECT' }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll('img')].every((img) => img.complete && img.naturalWidth > 0),
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'REWORK' }).click();
  await openFamily(page, 'QUARTER', 'Medial Quarter', 'Stitching');
  await choice(page, DEFECT).click();
  await choice(page, DEFECT).click();
  await expect(choice(page, DEFECT)).toContainText('2');
  await page.getByRole('button', { name: 'END INSPECTION' }).click();
  await bar(page, 'HOME').click();

  // Home (S3): results and Top 5.
  await expectResults(page, {
    po: '10.002',
    inspection: '1',
    defect: '2',
    aGrade: '0',
    bGrade: '0',
    defectRate: '200,0%',
    passRate: '0,0%',
  });
  await expectTop5(page, [[DEFECT, 'MAJOR', 2]]);

  // Photo (S7), PSI lv.2.
  const jpeg = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 900;
    const context2d = canvas.getContext('2d')!;
    context2d.fillStyle = 'teal';
    context2d.fillRect(0, 0, 1200, 900);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]!;
  });
  const chooser = page.waitForEvent('filechooser');
  await top5(page).getByRole('button', { name: 'Foto wajib' }).click();
  await (
    await chooser
  ).setFiles({ name: 'camera.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg, 'base64') });
  await expect(page.getByText('Foto tersimpan')).toBeVisible();

  // Export PDF and Excel (FR-12) load their code from the precache.
  for (const button of ['EXPORT PDF', 'EXPORT EXCEL'] as const) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: button }).click();
    expect((await download).suggestedFilename()).toMatch(/^M100_0903359388_\d{8}\.(pdf|xlsx)$/);
  }

  // SUBMIT PO (S8) queues the submission.
  await page.getByRole('button', { name: 'SUBMIT PO' }).click();
  await page
    .getByRole('dialog', { name: 'Submit PO' })
    .getByRole('button', { name: 'KIRIM' })
    .click();
  await expect(page.getByText('Tersimpan. Menunggu koneksi.')).toBeVisible();
  await expect(page.getByLabel(/pengiriman menunggu/)).toHaveText('1');
  expect(await outbox(page)).toMatchObject([{ po: PO, state: 'waiting' }]);

  // Login (S2) shows its offline notice instead of failing.
  await logout(page);
  await expect(
    page.getByText('Login butuh koneksi. Hubungkan Wi-Fi, lalu coba lagi.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'LOGIN' })).toBeDisabled();

  expect(failed).toEqual([]);
});
