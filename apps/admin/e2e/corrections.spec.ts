// A1b / A1c — correcting a submission (ADR-023, PRD FR-17, doc 05 §20.3, §20.3a) against the real API.
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, sendSubmission, signIn, test } from './fixtures';

const REASON = 'Salah input QTY INSPECTION oleh PSI';
const fact = (page: Page, label: string) =>
  page
    .locator('.adm-facts div')
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator('dd');

async function openForm(page: Page, id: string) {
  await page.goto(`/admin/submissions/${id}`);
  await page.getByRole('button', { name: 'KOREKSI' }).click();
  await expect(page.getByRole('heading', { name: /^Koreksi M100-/ })).toBeVisible();
}

async function saveWith(page: Page, reason: string) {
  await page.getByRole('button', { name: 'SIMPAN KOREKSI' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Simpan koreksi?' });
  await dialog.getByLabel('Alasan koreksi').fill(reason);
  await dialog.getByRole('button', { name: 'SIMPAN', exact: true }).click();
}

test('PSI lv.1: QTY INSPECTION is corrected with a reason; detail, history, list and the original show it', async ({
  page,
  account,
  sql,
}) => {
  const sent = await sendSubmission(sql, 'ADR-019', { level: 'PSI lv.1', reworkApproved: 1 });
  await signIn(page, account);
  await openForm(page, sent.id);

  // Unchanged: nothing to save.
  await expect(page.getByRole('button', { name: 'SIMPAN KOREKSI' })).toBeDisabled();
  await expect(page.getByLabel('Level')).toHaveValue('PSI lv.1');

  // Below Qty Defect (3) is refused on the spot with the API's own text.
  await page.getByLabel('QTY INSPECTION', { exact: true }).fill('2');
  await expect(
    page.getByText('Qty Inspection minimal 3: jumlah defect yang tercatat.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'SIMPAN KOREKSI' })).toBeDisabled();

  await page.getByLabel('QTY INSPECTION', { exact: true }).fill('25');
  await expect(fact(page, 'A-Grade')).toContainText('22');
  await page.getByRole('button', { name: 'SIMPAN KOREKSI' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Simpan koreksi?' });
  await expect(dialog).toContainText('QTY INSPECTION: 30 → 25');
  // A reason of fewer than 10 characters cannot be saved.
  await dialog.getByLabel('Alasan koreksi').fill('kurang');
  await expect(dialog.getByRole('button', { name: 'SIMPAN', exact: true })).toBeDisabled();
  await dialog.getByLabel('Alasan koreksi').fill(REASON);
  await dialog.getByRole('button', { name: 'SIMPAN', exact: true }).click();

  await expect(page.getByText('Koreksi disimpan (revisi 1).', { exact: false })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/admin/submissions/${sent.id}$`));
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Rev 1');
  await expect(fact(page, 'QTY INSPECTION')).toHaveText('25');
  await expect(page.getByText(`oleh ${account.username} (revisi 1): ${REASON}`)).toBeVisible();

  // The history: the PSI's version and the correction with its change.
  await expect(page.getByRole('link', { name: 'Dikirim PSI ANDI CONTOH' })).toBeVisible();
  await expect(page.getByRole('link', { name: `Revisi 1 oleh ${account.username}` })).toBeVisible();
  await expect(page.locator('.adm-history')).toContainText('QTY INSPECTION: 30 → 25');

  // The original stays readable, and cannot be corrected from there.
  await page.getByRole('link', { name: 'Dikirim PSI ANDI CONTOH' }).click();
  await expect(page.getByText('Revisi 0, bukan versi terbaru')).toBeVisible();
  await expect(fact(page, 'QTY INSPECTION')).toHaveText('30');
  await expect(page.getByRole('button', { name: 'KOREKSI' })).toHaveCount(0);

  // The list marks the corrected row and shows its new figures.
  await page.goto(`/admin/?po=${sent.po}`);
  const row = page.getByRole('row').filter({ hasText: sent.displayNo });
  await expect(row).toContainText('Rev 1');
  await expect(row.getByRole('cell').nth(5)).toHaveText('25');
});

test('PSI lv.2 (photo rule ALL): a photo is replaced and a new defect brings its own photo', async ({
  page,
  account,
  sql,
}) => {
  const sent = await sendSubmission(sql, 'ADR-008', { photoRule: 'ALL', reworkApproved: 0 });
  await signIn(page, account);
  await openForm(page, sent.id);

  const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(3000)]);
  await page
    .getByLabel('Ganti foto D035')
    .setInputFiles({ name: 'D035.jpg', mimeType: 'image/jpeg', buffer: jpeg() });

  // A new REWORK finding on the first sub-area's first defect: its photo is required.
  await page.getByRole('button', { name: 'TAMBAH FINDING' }).click();
  const n = await page.getByRole('row').count();
  const last = n - 2;
  await page.getByLabel(`Area temuan ${last + 1}`, { exact: true }).selectOption({ index: 1 });
  await page.getByLabel(`Sub-area temuan ${last + 1}`, { exact: true }).selectOption({ index: 1 });
  await page.getByLabel(`Defect temuan ${last + 1}`, { exact: true }).selectOption({ index: 1 });
  const added = await page.getByLabel(`Defect temuan ${last + 1}`, { exact: true }).inputValue();
  await expect(page.locator('.adm-photo-row').filter({ hasText: added })).toContainText(
    'Foto wajib',
  );
  await expect(page.getByRole('button', { name: 'SIMPAN KOREKSI' })).toBeDisabled();
  await page
    .getByLabel(`Ganti foto ${added}`)
    .setInputFiles({ name: `${added}.jpg`, mimeType: 'image/jpeg', buffer: jpeg() });

  await saveWith(page, 'Foto D035 salah, defect tertinggal');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Rev 1');
  const thumbs = page.locator('.adm-thumb img');
  await expect(thumbs).toHaveCount(3);
  await expect(
    page.locator('.adm-thumb').filter({ hasText: 'D035' }).locator('img'),
  ).toHaveAttribute('src', /\/v1\/admin\/revision-photos\/\d+$/);
  await expect(page.locator('.adm-history')).toContainText('Foto diganti: D035');
  await expect(page.locator('.adm-history')).toContainText(`Foto baru: ${added}`);
});

test('two admins on the same form: the second save gets the conflict notice and MUAT ULANG', async ({
  page,
  context,
  account,
  sql,
}) => {
  const sent = await sendSubmission(sql, 'ADR-019', { level: 'PSI lv.1' });
  await signIn(page, account);
  const other = await context.newPage();
  await openForm(page, sent.id);
  await openForm(other, sent.id);

  await page.getByLabel('QTY INSPECTION', { exact: true }).fill('28');
  await saveWith(page, REASON);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Rev 1');

  await other.getByLabel('QTY INSPECTION', { exact: true }).fill('27');
  await saveWith(other, REASON);
  await expect(
    other.getByText(
      'Submission ini baru saja dikoreksi admin lain. Muat ulang lalu ulangi koreksi.',
    ),
  ).toBeVisible();
  await other.getByRole('button', { name: 'MUAT ULANG' }).click();
  // Reloaded from revision 1: the form shows its value, and saving makes revision 2.
  await expect(other.getByLabel('QTY INSPECTION', { exact: true })).toHaveValue('28');
  await expect(other.getByText('Koreksi menjadi revisi 2.', { exact: false })).toBeVisible();
});
