// A6 admins, A7 audit log and the own-password dialog (doc 05 §20.6, doc 04 §10 A15, A16).
import { randomBytes } from 'node:crypto';
import { adminCookie, expect, signIn, test } from './fixtures';

const toast = (page: import('@playwright/test').Page) => page.locator('.m100-toast');

test('add an admin, reset their password, deactivate and reactivate them', async ({
  page,
  account,
}) => {
  const other = `e2e-new-${randomBytes(3).toString('hex')}`;
  await signIn(page, account);
  await page.goto('/admin/admins');

  // Own account: deactivating it is not offered.
  const self = page.getByRole('row').filter({ hasText: `${account.username} (Anda)` });
  await expect(
    self.getByRole('button', { name: `Nonaktifkan ${account.username}` }),
  ).toBeDisabled();

  await page.getByRole('button', { name: 'TAMBAH' }).click();
  let dialog = page.getByRole('dialog', { name: 'Tambah admin' });
  await dialog.getByLabel('Username').fill(other);
  await dialog.getByLabel('Password awal').fill('short');
  await expect(dialog.getByText('Minimal 10 karakter.').last()).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'SIMPAN' })).toBeDisabled();
  await dialog.getByLabel('Password awal').fill('first-password-1');
  await dialog.getByLabel('Ulangi password').fill('first-password-1');
  await dialog.getByRole('button', { name: 'SIMPAN' }).click();
  await expect(toast(page)).toHaveText(`Admin ${other} ditambahkan.`);
  const row = page.getByRole('row').filter({ hasText: other });
  await expect(row).toContainText('Ya');

  await row.getByRole('button', { name: `Reset password ${other}` }).click();
  dialog = page.getByRole('dialog', { name: `Reset password: ${other}` });
  await dialog.getByLabel('Password baru').fill('second-password-2');
  await dialog.getByLabel('Ulangi password').fill('second-password-2');
  await dialog.getByRole('button', { name: 'SIMPAN' }).click();
  await expect(toast(page)).toHaveText(`Password ${other} direset.`);
  await adminCookie(other, 'second-password-2');

  await row.getByRole('button', { name: `Nonaktifkan ${other}` }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Nonaktifkan admin' });
  await expect(confirm).toContainText(other);
  await confirm.getByRole('button', { name: 'NONAKTIFKAN' }).click();
  await expect(toast(page)).toHaveText(`${other} dinonaktifkan.`);
  await expect(row).toContainText('Tidak');

  await row.getByRole('button', { name: `Aktifkan ${other}` }).click();
  await page
    .getByRole('alertdialog', { name: 'Aktifkan admin' })
    .getByRole('button', { name: 'AKTIFKAN' })
    .click();
  await expect(row).toContainText('Ya');

  // A7: this admin's changes are in the log, newest first.
  await page
    .getByRole('navigation', { name: 'Menu admin' })
    .getByRole('link', { name: 'Audit log' })
    .click();
  await page.getByLabel('Admin', { exact: true }).fill(`admin:${account.username}`);
  await page.getByRole('button', { name: 'TAMPILKAN' }).click();
  await expect(page).toHaveURL(new RegExp(`actor=admin%3A${account.username}`));
  const log = page.getByRole('region', { name: 'Audit log' }).last();
  await expect(log.getByRole('row')).toHaveCount(6);
  await expect(log.getByRole('row').nth(1)).toContainText('reactivate');
  await expect(log.getByRole('row').nth(1)).toContainText('active: tidak → ya');
  await expect(log.getByRole('row').nth(4)).toContainText('create');
  await expect(log.getByRole('row').nth(5)).toContainText('login');
});

test('the audit log filters by date', async ({ page, account }) => {
  await signIn(page, account);
  await page.goto('/admin/audit-log');
  await page.getByLabel('Tanggal dari').fill('2020-01-01');
  await page.getByLabel('Tanggal sampai').fill('2020-01-02');
  await page.getByRole('button', { name: 'TAMPILKAN' }).click();
  await expect(page.getByText('Tidak ada catatan untuk filter ini.')).toBeVisible();
});

test('own password: change it from the header, then log in with the new one', async ({
  page,
  account,
}) => {
  await signIn(page, account);
  await page.getByRole('button', { name: `${account.username}, ganti password` }).click();
  const dialog = page.getByRole('dialog', { name: 'Ganti password' });
  await dialog.getByLabel('Password lama').fill('not-the-password');
  await dialog.getByLabel('Password baru', { exact: true }).fill('brand-new-password');
  await dialog.getByLabel('Ulangi password baru').fill('brand-new-password');
  await dialog.getByRole('button', { name: 'SIMPAN' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Password lama salah.');

  await dialog.getByLabel('Password lama').fill(account.password);
  await dialog.getByRole('button', { name: 'SIMPAN' }).click();
  await expect(toast(page)).toHaveText('Password diganti.');

  await page.getByRole('button', { name: 'LOGOUT' }).click();
  await signIn(page, { username: account.username, password: 'brand-new-password' });
});
