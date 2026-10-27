// Login and logout (T1.2: FR-01, FR-02), against the API and the web fixtures imported into its test database.
import { type Page } from '@playwright/test';
import { expect, test } from './fixtures';
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
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function login(page: Page) {
  await pick(page, 'Nama', 'DEWI CONTOH');
  await pick(page, 'Factory', 'F 3');
  await pick(page, 'Cell', 'F3-10');
  await page.getByRole('button', { name: 'LOGIN' }).click();
  await expect(page.getByRole('button', { name: 'Pengaturan' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Login PSI' })).toBeVisible();
});

test('logs in, survives a reload and logs out to an empty form (AC-01.2, AC-01.3, AC-02.1)', async ({
  page,
}) => {
  await expect(page.getByRole('button', { name: 'LOGIN' })).toBeDisabled();
  await expect(page.getByText('Pilih nama, factory, dan cell.')).toBeVisible();
  await login(page);

  const account = page.getByLabel('Akun');
  await expect(account).toContainText('DEWI CONTOH');
  await expect(account).toContainText('PSI lv.2');
  await expect(page.getByLabel('Info PO')).toContainText('F3-10');

  await page.reload();
  await expect(page.getByLabel('Akun')).toContainText('DEWI CONTOH');

  await page.getByRole('button', { name: 'Pengaturan' }).click();
  const menu = page.getByRole('dialog', { name: 'Pengaturan' });
  await expect(menu).toContainText('Factory/Cell F3-10');
  await menu.getByRole('button', { name: 'LOGOUT' }).click();

  await expect(page.getByRole('heading', { name: 'Login PSI' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Nama/ })).toContainText('Pilih nama');
  await expect(page.getByRole('button', { name: 'LOGIN' })).toBeDisabled();
});

test('selects the only cell of a factory by itself', async ({ page }) => {
  await pick(page, 'Factory', 'F 1');
  await expect(page.getByRole('button', { name: /^Cell/ })).toContainText('F1-01');
});

// The dialog is capped at the screen height (app.css): a long PSI list scrolls inside its frame instead of being
// cut off at the bottom of the screen (doc 05 §7).
test('the Nama picker scrolls to every name instead of cutting the list off', async ({ page }) => {
  const height = 412;
  await page.setViewportSize({ width: 915, height });
  await page.getByRole('button', { name: /^Nama/ }).click();

  const dialog = page.getByRole('dialog', { name: 'Pilih nama' });
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y, 'dialog top is on screen').toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, 'dialog fits the screen').toBeLessThanOrEqual(height);

  const list = dialog.getByRole('listbox');
  const last = list.getByRole('option').last();
  await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(last, 'the last name is fully visible once scrolled').toBeInViewport({ ratio: 1 });
  await last.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Nama/ })).not.toContainText('Pilih nama');
});

test('disables LOGIN while offline and says why (U4)', async ({ page, context }) => {
  await pick(page, 'Nama', 'ANDI CONTOH');
  await pick(page, 'Factory', 'F 1');
  await context.setOffline(true);
  await expect(
    page.getByText('Login butuh koneksi. Hubungkan Wi-Fi, lalu coba lagi.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'LOGIN' })).toBeDisabled();
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: 'LOGIN' })).toBeEnabled();
});

for (const viewport of VIEWPORTS) {
  test(`every tappable element is ≥ 44 × 44 px at ${viewport.width} × ${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const label = `${viewport.width} × ${viewport.height}`;
    expect(await undersized(page), `login ${label}`).toEqual([]);
    await page.screenshot({
      path: `test-results/login-form-${viewport.width}x${viewport.height}.png`,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no sideways scroll ${label}`,
    ).toBe(true);

    for (const field of ['Nama', 'Factory'] as const) {
      await page.getByRole('button', { name: new RegExp(`^${field}`) }).click();
      expect(await undersized(page), `${field} picker ${label}`).toEqual([]);
      await page.keyboard.press('Escape');
    }

    await login(page);
    expect(await undersized(page), `home ${label}`).toEqual([]);
    await page.getByRole('button', { name: 'Pengaturan' }).click();
    expect(await undersized(page), `settings ${label}`).toEqual([]);
    await page.screenshot({
      path: `test-results/settings-${viewport.width}x${viewport.height}.png`,
    });
  });
}
