// A2–A5 — PSI users, factories & cells, POs, defects & area map (doc 05 §20.4, §20.5, AC-14.1, AC-14.2).
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, problem, signIn, test } from './fixtures';

const SAVED = 'Disimpan. Tablet menerima perubahan dalam 30 menit.';
const unique = (prefix: string) => `${prefix} ${randomBytes(3).toString('hex').toUpperCase()}`;
const toast = (page: Page) => page.locator('.m100-toast');

async function open(page: Page, link: string, heading: string) {
  await page
    .getByRole('navigation', { name: 'Menu admin' })
    .getByRole('link', { name: link })
    .click();
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}

test.describe('A2 PSI users', () => {
  test('add, refuse a duplicate, add at the other level and deactivate', async ({
    page,
    account,
  }) => {
    const name = unique('E2E PSI');
    await signIn(page, account);
    await open(page, 'User PSI', 'User PSI');

    await page.getByRole('button', { name: 'TAMBAH' }).first().click();
    let dialog = page.getByRole('dialog', { name: 'Tambah user PSI' });
    await dialog.getByLabel('Nama').fill(name);
    await dialog.getByLabel('Level').selectOption('PSI lv.2');
    await dialog.getByRole('button', { name: 'SIMPAN' }).click();
    await expect(toast(page)).toHaveText(SAVED);
    await page.getByLabel('Cari nama').fill(name);
    await expect(page.getByRole('row').filter({ hasText: name })).toContainText('PSI lv.2');

    // The same name and level again: 409 CONFLICT.
    await page.getByRole('button', { name: 'TAMBAH' }).first().click();
    dialog = page.getByRole('dialog', { name: 'Tambah user PSI' });
    await dialog.getByLabel('Nama').fill(name);
    await dialog.getByLabel('Level').selectOption('PSI lv.2');
    await dialog.getByRole('button', { name: 'SIMPAN' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Nama dan level ini sudah ada.');
    await dialog.getByRole('button', { name: 'BATAL' }).click();
    await dialog.getByRole('button', { name: 'TUTUP TANPA MENYIMPAN' }).click();
    await expect(dialog).toHaveCount(0);

    // A name may exist at both levels.
    await page.getByRole('button', { name: 'TAMBAH' }).first().click();
    dialog = page.getByRole('dialog', { name: 'Tambah user PSI' });
    await dialog.getByLabel('Nama').fill(name);
    await dialog.getByRole('button', { name: 'SIMPAN' }).click();
    await expect(toast(page)).toHaveText(SAVED);
    await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(2);

    // Deactivate the lv.2 row: it stays listed, marked Tidak.
    await page.getByRole('button', { name: `Ubah ${name} PSI lv.2` }).click();
    dialog = page.getByRole('dialog', { name: `Ubah user PSI: ${name}` });
    await expect(dialog.getByRole('button', { name: 'SIMPAN' })).toBeDisabled();
    await dialog.getByLabel('Aktif').uncheck();
    await dialog.getByRole('button', { name: 'SIMPAN' }).click();
    await expect(toast(page)).toHaveText(SAVED);
    await expect(
      page.getByRole('row').filter({ hasText: name }).filter({ hasText: 'PSI lv.2' }),
    ).toContainText('Tidak');
  });

  test('an unsaved form asks before closing and before leaving', async ({ page, account }) => {
    await signIn(page, account);
    await open(page, 'User PSI', 'User PSI');
    await page.getByRole('button', { name: 'TAMBAH' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Tambah user PSI' });
    await dialog.getByLabel('Nama').fill('Belum disimpan');

    await page.keyboard.press('Escape');
    await expect(
      dialog.getByText('Perubahan belum disimpan. Tutup tanpa menyimpan?'),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'KEMBALI' }).click();
    await expect(dialog.getByLabel('Nama')).toHaveValue('Belum disimpan');

    // The browser back button asks too, and stays until answered.
    await page.goBack();
    await expect(
      dialog.getByText('Perubahan belum disimpan. Tutup tanpa menyimpan?'),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/psi-users$/);
    await dialog.getByRole('button', { name: 'TUTUP TANPA MENYIMPAN' }).click();
    await expect(page.getByRole('heading', { name: 'Submission', level: 1 })).toBeVisible();
  });

  test('loading and error states', async ({ page, account }) => {
    await signIn(page, account);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/v1/admin/psi-users', async (route) => {
      await held;
      await route.fulfill(problem(503, 'DB_UNAVAILABLE', 'Database sedang tidak tersedia.'));
    });
    await open(page, 'User PSI', 'User PSI');
    await expect(page.getByText('Memuat…')).toBeVisible();
    release();
    await expect(page.getByRole('alert')).toHaveText('Database sedang tidak tersedia.');
    await page.unroute('**/v1/admin/psi-users');
    await page.getByRole('button', { name: 'COBA LAGI' }).click();
    await expect(page.getByRole('region', { name: 'Daftar user PSI' })).toBeVisible();
  });
});

test.describe('A3 Factories & cells', () => {
  test('two linked tables: add a factory, then a cell in it', async ({ page, account }) => {
    const factory = unique('E2E F');
    const cell = unique('E2E C');
    await signIn(page, account);
    await open(page, 'Factory & cell', 'Factory & cell');

    // Cells follow the chosen factory.
    await page.getByRole('button', { name: 'F 3', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Daftar cell F 3' })).toContainText('F3-10');

    await page
      .getByRole('region', { name: 'Factory', exact: true })
      .getByRole('button', { name: 'TAMBAH' })
      .click();
    let dialog = page.getByRole('dialog', { name: 'Tambah factory' });
    await dialog.getByLabel('Nama factory').fill(factory);
    await dialog.getByRole('button', { name: 'SIMPAN' }).click();
    await expect(toast(page)).toHaveText(SAVED);

    await page.getByRole('button', { name: factory, exact: true }).click();
    await expect(page.getByText(`Belum ada cell di ${factory}.`)).toBeVisible();
    await page
      .getByRole('region', { name: `Cell ${factory}` })
      .getByRole('button', { name: 'TAMBAH' })
      .click();
    dialog = page.getByRole('dialog', { name: 'Tambah cell' });
    await expect(dialog.getByLabel('Factory')).toHaveValue(/\d+/);
    await dialog.getByLabel('Kode cell').fill(cell);
    await dialog.getByRole('button', { name: 'SIMPAN' }).click();
    await expect(toast(page)).toHaveText(SAVED);
    await expect(page.getByRole('region', { name: `Daftar cell ${factory}` })).toContainText(cell);

    // A duplicate factory name is refused with the server's text.
    await page
      .getByRole('region', { name: 'Factory', exact: true })
      .getByRole('button', { name: 'TAMBAH' })
      .click();
    dialog = page.getByRole('dialog', { name: 'Tambah factory' });
    await dialog.getByLabel('Nama factory').fill(factory);
    await dialog.getByRole('button', { name: 'SIMPAN' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
  });
});

test.describe('A4 POs', () => {
  test('search, add and edit one PO', async ({ page, account }) => {
    const po = `E2E${randomBytes(4).toString('hex').toUpperCase()}`;
    await signIn(page, account);
    await open(page, 'PO', 'PO');
    await expect(
      page.getByText('Ketik nomor PO, article atau model lalu tekan CARI.'),
    ).toBeVisible();
    await page.getByLabel('Cari PO / article / model').fill('09');
    await expect(page.getByRole('button', { name: 'CARI' })).toBeDisabled();

    await page.getByLabel('Cari PO / article / model').fill('9388');
    await page.getByRole('button', { name: 'CARI' }).click();
    await expect(page.getByRole('row').filter({ hasText: '0903359388' })).toBeVisible();

    await page.getByRole('button', { name: 'TAMBAH' }).click();
    let dialog = page.getByRole('dialog', { name: 'Tambah PO' });
    await dialog.getByLabel('PO', { exact: true }).fill(po);
    await dialog.getByLabel('Article').fill('ART-1');
    await dialog.getByLabel('Model').fill('MODEL E2E');
    await dialog.getByLabel('Destination').fill('JAPAN');
    await dialog.getByLabel('Order qty').fill('0');
    await expect(dialog.getByText('Bilangan bulat, minimal 1.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'SIMPAN' })).toBeDisabled();
    await dialog.getByLabel('Order qty').fill('1200');
    await dialog.getByLabel('PODD').fill('2026-11-01');
    await dialog.getByRole('button', { name: 'SIMPAN' }).click();
    await expect(toast(page)).toHaveText(SAVED);

    await page.getByLabel('Cari PO / article / model').fill(po);
    await page.getByRole('button', { name: 'CARI' }).click();
    const row = page.getByRole('row').filter({ hasText: po });
    await expect(row).toContainText('1.200');
    await expect(row).toContainText('01 Nov 2026');

    await page.getByRole('button', { name: `Ubah PO ${po}` }).click();
    dialog = page.getByRole('dialog', { name: `Ubah PO ${po}` });
    await expect(dialog.getByLabel('PO', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('Article').fill('ART-2');
    await dialog.getByLabel('Aktif').uncheck();
    await dialog.getByRole('button', { name: 'SIMPAN' }).click();
    await expect(toast(page)).toHaveText(SAVED);
    await expect(row).toContainText('ART-2');
    await expect(row).toContainText('Tidak');
  });

  test('no hits', async ({ page, account }) => {
    await signIn(page, account);
    await open(page, 'PO', 'PO');
    await page.getByLabel('Cari PO / article / model').fill('ZZZ-NONE');
    await page.getByRole('button', { name: 'CARI' }).click();
    await expect(page.getByText('Tidak ada PO untuk “ZZZ-NONE”.')).toBeVisible();
  });
});

test.describe('A5 Defects & area map', () => {
  test('tabs, and switching a defect off and on through a dialog that names it', async ({
    page,
    account,
  }) => {
    await signIn(page, account);
    await open(page, 'Defect & area map', 'Defect & area map');
    const defects = page.getByRole('region', { name: 'Daftar defect' });
    // D001–D098, plus the header row.
    await expect(defects.getByRole('row')).toHaveCount(99);

    // D001, which no other test sends; it is switched back on at the end.
    await page.getByRole('button', { name: 'Nonaktifkan D001' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Nonaktifkan' });
    await expect(confirm).toContainText('D001 OUTER CARTON');
    await confirm.getByRole('button', { name: 'NONAKTIFKAN' }).click();
    await expect(toast(page)).toHaveText(SAVED);
    await expect(defects.getByRole('row').filter({ hasText: 'D001' })).toContainText('Tidak');
    await page.getByRole('button', { name: 'Aktifkan D001' }).click();
    await page
      .getByRole('alertdialog', { name: 'Aktifkan' })
      .getByRole('button', { name: 'AKTIFKAN' })
      .click();
    await expect(defects.getByRole('row').filter({ hasText: 'D001' })).toContainText('Ya');

    // Tabs work with the arrow keys.
    await page.getByRole('tab', { name: 'Defect' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Area, sub-area & family' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('region', { name: 'Area', exact: true })).toContainText('Toe Box');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Map' })).toBeFocused();
    await page.getByLabel('Cari defect').fill('D035');
    await expect(page.getByRole('region', { name: 'Map' }).getByRole('row').nth(1)).toContainText(
      'D035',
    );
  });
});
