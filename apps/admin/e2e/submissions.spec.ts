// A1 / A1b — the read-only submissions DataTable, its detail, photos and CSV export (doc 05 §20.3, AC-14.4).
import { defectName, expect, problem, sendSubmission, signIn, test } from './fixtures';

test('a submission from a tablet is listed, opens its detail and its photos', async ({
  page,
  account,
  sql,
}) => {
  const sent = await sendSubmission(sql);
  await signIn(page, account);

  // Default filter: today (WIB). Narrow to the PO so other tests' rows don't matter.
  await page.getByLabel('PO', { exact: true }).fill(sent.po);
  await page.getByRole('button', { name: 'TAMPILKAN' }).click();
  const row = page.getByRole('row').filter({ hasText: sent.displayNo });
  await expect(row).toContainText('DEWI CONTOH');
  await expect(row).toContainText('F 3 / F3-10');
  // 6 inspections, 3 defects (2 REWORK + 1 B-GRADE), 3 A-Grade, 1 B-Grade.
  await expect(row.getByRole('cell')).toHaveText([
    sent.displayNo,
    /WIB$/,
    /DEWI CONTOH\s+PSI lv\.2/,
    'F 3 / F3-10',
    sent.po,
    '6',
    '3',
    '3',
    '1',
    '50,0%',
    '50,0%',
    '2',
  ]);

  // The CSV link carries the filter (A14).
  const csv = page.getByRole('link', { name: 'EXPORT CSV' });
  await expect(csv).toHaveAttribute('href', new RegExp(`po=${sent.po}`));
  const download = page.waitForEvent('download');
  await csv.click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^m100-submissions-.*\.csv$/);

  await row.getByRole('link', { name: sent.displayNo }).click();
  await expect(page.getByRole('heading', { name: sent.displayNo })).toBeVisible();
  await expect(page.getByText(defectName('D035')).first()).toBeVisible();
  const findings = page.getByRole('region', { name: 'Temuan' });
  await expect(findings.getByRole('row')).toHaveCount(3);
  await expect(findings.getByRole('row').nth(1)).toContainText('REWORK');
  await expect(findings.getByRole('row').nth(2)).toContainText('B-GRADE');

  // Photo strip through GET /admin/photos/{id}; a click opens the large view.
  const thumbs = page.getByRole('button', { name: /^Foto D0/ });
  await expect(thumbs).toHaveCount(2);
  const src = await thumbs.first().locator('img').getAttribute('src');
  const answer = await page.request.get(src!);
  expect(answer.status()).toBe(200);
  expect(answer.headers()['content-type']).toBe('image/jpeg');
  await thumbs.first().click();
  const large = page.getByRole('dialog', { name: /^Foto D0/ });
  await expect(large.getByRole('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(large).toHaveCount(0);
  await expect(thumbs.first()).toBeFocused();

  // Read-only: nothing on the page changes the submission.
  await expect(page.getByRole('button', { name: /UBAH|HAPUS|VOID|SIMPAN/ })).toHaveCount(0);
  await expect(page.getByText('Belum ada catatan audit untuk submission ini.')).toBeVisible();

  // Back to the list keeps the filter in the URL.
  await page.goBack();
  await expect(page.getByLabel('PO', { exact: true })).toHaveValue(sent.po);
});

test('the photo endpoint answers only a signed-in admin', async ({ page, sql, account }) => {
  const sent = await sendSubmission(sql);
  await signIn(page, account);
  await page.goto(`/admin/submissions/${sent.id}`);
  const src = await page
    .getByRole('button', { name: /^Foto D0/ })
    .first()
    .locator('img')
    .getAttribute('src');
  expect(src).toMatch(/^\/v1\/admin\/photos\/\d+$/);
  await page.context().clearCookies();
  const response = await page.request.get(src!);
  expect(response.status()).toBe(401);
});

test('empty, loading and error states of A1', async ({ page, account }) => {
  await signIn(page, account);
  await page.getByLabel('PO', { exact: true }).fill('no-such-po-x');
  await page.getByRole('button', { name: 'TAMPILKAN' }).click();
  await expect(page.getByText('Tidak ada submission untuk filter ini.')).toBeVisible();

  // Loading: the answer is held back.
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/v1/admin/submissions?*', async (route) => {
    await held;
    await route.fallback();
  });
  await page.getByLabel('PO', { exact: true }).fill('no-such-po-y');
  await page.getByRole('button', { name: 'TAMPILKAN' }).click();
  await expect(page.getByText('Memuat…')).toBeVisible();
  release();
  await expect(page.getByText('Tidak ada submission untuk filter ini.')).toBeVisible();
  await page.unroute('**/v1/admin/submissions?*');

  // Error: the API detail in a danger Notice, and COBA LAGI.
  await page.route('**/v1/admin/submissions?*', (route) =>
    route.fulfill(problem(503, 'DB_UNAVAILABLE', 'Database sedang tidak tersedia.')),
  );
  await page.getByLabel('PO', { exact: true }).fill('no-such-po-z');
  await page.getByRole('button', { name: 'TAMPILKAN' }).click();
  await expect(page.getByRole('alert')).toHaveText('Database sedang tidak tersedia.');
  await page.unroute('**/v1/admin/submissions?*');
  await page.getByRole('button', { name: 'COBA LAGI' }).click();
  await expect(page.getByText('Tidak ada submission untuk filter ini.')).toBeVisible();
});

test('a bad filter shows the API problem (422)', async ({ page, account }) => {
  await signIn(page, account);
  await page.getByLabel('Tanggal dari').fill('2026-10-20');
  await page.getByLabel('Tanggal sampai').fill('2026-10-01');
  await page.getByRole('button', { name: 'TAMPILKAN' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
});

test('an unknown submission id is a 404 notice without COBA LAGI', async ({ page, account }) => {
  await signIn(page, account);
  await page.goto('/admin/submissions/00000000-0000-4000-8000-000000000000');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'COBA LAGI' })).toHaveCount(0);
});
