// A0 — login, lockout, session end and logout (doc 05 §20.2, T3b.4).
import { expect, problem, signIn, test } from './fixtures';

test('logs in to A1 and out again', async ({ page, account }) => {
  await signIn(page, account);
  await expect(
    page.getByRole('button', { name: `${account.username}, ganti password` }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'LOGOUT' }).click();
  await expect(page.getByRole('button', { name: 'MASUK' })).toBeVisible();
  // The cookie is gone: a reload stays on the login screen.
  await page.reload();
  await expect(page.getByRole('button', { name: 'MASUK' })).toBeVisible();
});

test('a wrong password says so; the 5th locks the account for 10 minutes', async ({
  page,
  account,
}) => {
  await page.goto('/admin/');
  await page.getByLabel('Username').fill(account.username);
  for (let i = 1; i <= 4; i++) {
    await page.getByLabel('Password').fill(`wrong-${String(i)}`);
    await page.getByRole('button', { name: 'MASUK' }).click();
    await expect(page.getByRole('alert')).toHaveText('Username atau password salah.');
  }
  await page.getByLabel('Password').fill('wrong-5');
  await page.getByRole('button', { name: 'MASUK' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Akun dikunci 10 menit karena terlalu banyak percobaan.',
  );
  // Locked: even the right password is refused (ADMIN_LOCKED).
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'MASUK' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Akun dikunci 10 menit karena terlalu banyak percobaan.',
  );
});

test('an unknown username gets the same message', async ({ page }) => {
  await page.goto('/admin/');
  await page.getByLabel('Username').fill('nobody-here');
  await page.getByLabel('Password').fill('whatever-123');
  await page.getByRole('button', { name: 'MASUK' }).click();
  await expect(page.getByRole('alert')).toHaveText('Username atau password salah.');
});

test('an ended session returns to the login screen with a notice', async ({ page, account }) => {
  await signIn(page, account);
  // The 8-hour cookie runs out: the browser no longer sends it.
  await page.context().clearCookies();
  await page.getByRole('link', { name: 'User PSI' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Sesi berakhir' })).toHaveText(
    'Sesi berakhir. Silakan masuk lagi.',
  );
  await expect(page.getByRole('button', { name: 'MASUK' })).toBeVisible();
  // Logging in again lands on the page that was asked for.
  await page.getByLabel('Username').fill(account.username);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'MASUK' }).click();
  await expect(page.getByRole('heading', { name: 'User PSI', level: 1 })).toBeVisible();
});

test('the server being down at start shows the error and COBA LAGI', async ({ page }) => {
  let down = true;
  await page.route('**/v1/admin/me', (route) =>
    down
      ? route.fulfill(problem(503, 'DB_UNAVAILABLE', 'Database tidak tersedia.'))
      : route.fallback(),
  );
  await page.goto('/admin/');
  await expect(page.getByRole('alert')).toHaveText('Database tidak tersedia.');
  down = false;
  await page.getByRole('button', { name: 'COBA LAGI' }).click();
  await expect(page.getByRole('button', { name: 'MASUK' })).toBeVisible();
});
