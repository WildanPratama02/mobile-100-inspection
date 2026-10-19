// Home: PO list, Add PO with PO PARTIAL, Partial dialog, results and Top 5 (T1.3: FR-03, FR-04, FR-05).
import { expect, test, type Page } from '@playwright/test';
import { undersized } from './tap';

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 915, height: 412 },
  { width: 800, height: 1280 },
];

async function pick(page: Page, field: 'Nama' | 'Factory' | 'Cell', option: string) {
  await page.getByRole('button', { name: new RegExp(`^${field}`) }).click();
  await page
    .getByRole('dialog')
    .getByRole('option', { name: new RegExp(`^${option}`) })
    .click();
}

async function login(page: Page) {
  await page.goto('/');
  await pick(page, 'Nama', 'DEWI CONTOH');
  await pick(page, 'Factory', 'F 3');
  await pick(page, 'Cell', 'F3-10');
  await page.getByRole('button', { name: 'LOGIN' }).click();
  await expect(page.getByRole('button', { name: 'Pengaturan' })).toBeVisible();
}

async function openSearch(page: Page, q: string) {
  await page.getByRole('button', { name: 'Tambah PO' }).click();
  const dialog = page.getByRole('dialog', { name: 'Tambah PO' });
  await dialog.getByRole('button', { name: /^PO NUMBER/ }).click();
  await dialog.getByRole('searchbox').fill(q);
  return dialog;
}

async function addPo(page: Page, po: string, partialQty?: string) {
  const dialog = await openSearch(page, po);
  await dialog.getByRole('option', { name: new RegExp(`^${po}`) }).click();
  if (partialQty) {
    await dialog.getByRole('checkbox', { name: /PO PARTIAL/ }).click();
    const keys = dialog.getByRole('group', { name: 'Qty partial' });
    for (const d of partialQty) await keys.getByRole('button', { name: d, exact: true }).click();
  }
  await dialog.getByRole('button', { name: 'ADD TO PO LIST' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

const poRow = (page: Page, po: string) =>
  page.getByRole('region', { name: 'PO LIST' }).getByRole('button', { name: new RegExp(`^${po}`) });

async function longPress(page: Page, po: string) {
  const box = (await poRow(page, po).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
}

/** Text fields on the page; the PO search box is the only one the app ever shows (doc 05 G1). */
const textFields = (page: Page) =>
  page.locator('input, textarea, select, [contenteditable="true"]');

test('adds a PO with PO PARTIAL, keeps it over a reload, changes and removes it (FR-03)', async ({
  page,
}) => {
  await login(page);
  await expect(page.getByText('Belum ada PO')).toBeVisible();
  await expect(page.getByRole('button', { name: 'ADD DEFECT' })).toBeDisabled();
  await expect(textFields(page)).toHaveCount(0);

  const dialog = await openSearch(page, '0903359');
  await expect(textFields(page)).toHaveCount(1);
  await expect(dialog.getByRole('option')).toHaveCount(3);
  await dialog.getByRole('option', { name: /^0903359388/ }).click();
  await expect(textFields(page)).toHaveCount(0);
  await expect(dialog.getByLabel('Detail PO')).toContainText('10.002');
  await dialog.getByRole('checkbox', { name: /PO PARTIAL/ }).click();
  const keys = dialog.getByRole('group', { name: 'Qty partial' });
  for (const d of '1200') await keys.getByRole('button', { name: d, exact: true }).click();
  await dialog.getByRole('button', { name: 'ADD TO PO LIST' }).click();

  await expect(page.getByText('PO ditambahkan')).toBeVisible();
  const info = page.getByLabel('Info PO');
  await expect(info).toContainText('0903359388');
  await expect(info).toContainText('P1 · 1.200 dari 10.002');
  await expect(page.getByText('Belum ada defect')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Hasil' })).toContainText('10.002');

  await page.reload();
  await expect(poRow(page, '0903359388')).toHaveAttribute('aria-current', 'true');
  await expect(info).toContainText('P1 · 1.200 dari 10.002');

  // The PO already listed can't be added twice (AC-03.1).
  const again = await openSearch(page, '0903359388');
  await expect(again.getByRole('option', { name: /^0903359388/ })).toBeDisabled();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'UBAH PARTIAL' }).click();
  const partial = page.getByRole('dialog', { name: 'PO Partial' });
  await partial.getByRole('checkbox', { name: /PO PARTIAL/ }).click();
  await partial.getByRole('button', { name: 'SIMPAN' }).click();
  await expect(info).not.toContainText('dari 10.002');
  await expect(page.getByRole('button', { name: 'PO PARTIAL' })).toBeVisible();

  await addPo(page, 'CX-0902368685');
  await expect(poRow(page, 'CX-0902368685')).toHaveAttribute('aria-current', 'true');
  await poRow(page, '0903359388').click();
  await expect(info).toContainText('0903359388');

  await longPress(page, 'CX-0902368685');
  const remove = page.getByRole('dialog', { name: 'Hapus PO dari list?' });
  await expect(remove).toContainText('CX-0902368685');
  await remove.getByRole('button', { name: 'HAPUS' }).click();
  await expect(poRow(page, 'CX-0902368685')).toHaveCount(0);
  await page.reload();
  await expect(poRow(page, 'CX-0902368685')).toHaveCount(0);
  await expect(poRow(page, '0903359388')).toBeVisible();
});

test('PO search says it needs a connection when offline (AC-13.3)', async ({ page, context }) => {
  await login(page);
  await context.setOffline(true);
  const dialog = await openSearch(page, '0903');
  await expect(
    dialog.getByText('Cari PO butuh koneksi. Hubungkan Wi-Fi, lalu coba lagi.'),
  ).toBeVisible();
  await context.setOffline(false);
  await expect(dialog.getByRole('option').first()).toBeVisible();
});

for (const viewport of VIEWPORTS) {
  test(`Home and its dialogs fit ${viewport.width} × ${viewport.height} with ≥ 44 px targets`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const label = `${viewport.width}x${viewport.height}`;
    const check = async (what: string) => {
      expect(await undersized(page), `${what} ${label}`).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `no sideways scroll: ${what} ${label}`,
      ).toBe(true);
      await page.screenshot({ path: `test-results/home-${what}-${label}.png` });
    };

    await login(page);
    await check('empty');

    await addPo(page, '0903359388', '1200');
    await addPo(page, 'CX-0902368685');
    await addPo(page, '0903359401');
    await check('with-po');

    const dialog = await openSearch(page, '0903');
    await expect(dialog.getByRole('option').first()).toBeVisible();
    await check('add-po-search');
    await dialog.getByRole('option', { name: /^0903360015/ }).click();
    await dialog.getByRole('checkbox', { name: /PO PARTIAL/ }).click();
    await check('add-po-partial');
    await page.keyboard.press('Escape');

    await poRow(page, '0903359388').click();
    await page.getByRole('button', { name: 'UBAH PARTIAL' }).click();
    await check('partial');
  });
}
