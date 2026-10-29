// A1 / A1b — the read-only submissions DataTable, its detail, photos and CSV export (doc 05 §20.3, AC-14.4).
import { defectName, expect, problem, sendSubmission, signIn, test } from './fixtures';
import { readFile } from 'node:fs/promises';

for (const rule of ['ADR-008', 'ADR-019'] as const) {
  test(`${rule}: a submission from a tablet is listed, opens its detail and its photos`, async ({
    page,
    account,
    sql,
  }) => {
    const sent = await sendSubmission(sql, rule);
    const manual = rule === 'ADR-019';
    const ruleLabel = manual ? 'Qty Inspection diisi PSI' : 'Hitung per tap (lama)';
    await signIn(page, account);

    // Default filter: today (WIB). Narrow to the PO so other tests' rows don't matter.
    await page.getByLabel('PO', { exact: true }).fill(sent.po);
    await page.getByRole('button', { name: 'TAMPILKAN' }).click();
    const row = page.getByRole('row').filter({ hasText: sent.displayNo });
    await expect(row).toContainText('DEWI CONTOH');
    await expect(row).toContainText('F 3 / F3-10');
    // The saved counting rule determines the totals; the admin must never recalculate legacy rows.
    await expect(row.getByRole('cell')).toHaveText([
      sent.displayNo,
      /WIB$/,
      /DEWI CONTOH\s+PSI lv\.2/,
      'F 3 / F3-10',
      sent.po,
      manual ? '30' : '6',
      '3',
      manual ? '27' : '3',
      '1',
      manual ? '90,0%' : '50,0%',
      manual ? '10,0%' : '50,0%',
      '2',
      ruleLabel,
    ]);

    // The CSV link carries the filter (A14).
    const csv = page.getByRole('link', { name: 'EXPORT CSV' });
    await expect(csv).toHaveAttribute('href', new RegExp(`po=${sent.po}`));
    const download = page.waitForEvent('download');
    await csv.click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^m100-submissions-.*\.csv$/);
    const text = await readFile(await file.path(), 'utf8');
    const [header, ...lines] = text
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
    const columns = header!.split(',');
    const cells = lines.find((line) => line.includes(sent.id))!.split(',');
    expect(cells[columns.indexOf('counting_rule')]).toBe(rule);
    expect(cells[columns.indexOf('qty_no_defect')]).toBe(manual ? '' : '3');

    await row.getByRole('link', { name: sent.displayNo }).click();
    await expect(page.getByRole('heading', { name: sent.displayNo })).toBeVisible();
    const fact = (label: string) =>
      page.getByText(label, { exact: true }).locator('..').locator('dd');
    await expect(fact('Aturan hitung')).toHaveText(ruleLabel);
    await expect(fact('QTY INSPECTION')).toHaveText(manual ? '30' : '6');
    await expect(fact('REWORK (pasang)')).toHaveText('2');
    await expect(fact('B-GRADE (pasang)')).toHaveText('1');
    await expect(fact('A-Grade')).toHaveText(manual ? '27' : '3');
    if (manual) await expect(page.getByText('NO DEFECT', { exact: true })).toHaveCount(0);
    else await expect(fact('NO DEFECT')).toHaveText('3');
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
}

test('the same list distinguishes manual quantities from legacy tap counts', async ({
  page,
  account,
  sql,
}) => {
  const legacy = await sendSubmission(sql, 'ADR-008');
  const manual = await sendSubmission(sql, 'ADR-019');
  await signIn(page, account);
  await page.getByLabel('PO', { exact: true }).fill(manual.po);
  await page.getByRole('button', { name: 'TAMPILKAN' }).click();
  await expect(page.getByRole('row').filter({ hasText: legacy.displayNo })).toContainText(
    'Hitung per tap (lama)',
  );
  await expect(page.getByRole('row').filter({ hasText: manual.displayNo })).toContainText(
    'Qty Inspection diisi PSI',
  );
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
