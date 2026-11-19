// An admin correction reaches the tablet (ADR-023, PRD AC-17.6, AC-12.5, doc 03 §4.11) against the real API: the PSI
// submits, the correction is written (here straight into the test database, as the admin endpoint would: the admin
// screens have their own tests in apps/admin/e2e/corrections.spec.ts), and Pengaturan and EXPORT EXCEL show it.
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { expect, test } from './fixtures';
import { addPo, login, outbox, setQtyInspection } from './helpers';

const REASON = 'QTY INSPECTION salah input oleh PSI';

test.beforeEach(async ({ page }) => {
  // Desktop Chromium has the save dialog, which a test can't answer; the tablet's Chrome downloads.
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
});

test('a corrected submission shows "Dikoreksi admin" with the reason, and EXPORT EXCEL is made from it', async ({
  page,
  sql,
}) => {
  await page.goto('/');
  await login(page, 'ANDI CONTOH');
  await addPo(page, '0903359388');
  await setQtyInspection(page, 30);
  await page.getByRole('button', { name: 'SUBMIT PO' }).click();
  await page
    .getByRole('dialog', { name: 'Submit PO' })
    .getByRole('button', { name: 'KIRIM' })
    .click();
  await expect.poll(async () => (await outbox(page)).map((o) => o.state)).toEqual(['sent']);
  const [sent] = await outbox(page);
  const { submissionUuid } = JSON.parse(sent!.payloadJson) as { submissionUuid: string };

  // The admin corrects QTY INSPECTION 30 → 25 (doc 02 §6.5 writes these rows).
  const { rows } = await sql<{ id: number }>(
    `INSERT INTO admins (username, password_hash, active) VALUES ($1, 'not-a-hash', true) RETURNING id`,
    [`e2e-tablet-${submissionUuid.slice(0, 8)}`],
  );
  await sql(
    `INSERT INTO submission_revisions (
       id, submission_id, revision_no, request_sha256, admin_id, admin_username, reason,
       sealed_at, inspection_date, username, factory, cell, po, article, model, destination, order_qty, podd, crd,
       partial_no, partial_qty, qty_rework, qty_bgrade_inspections, qty_rework_approved, qty_no_defect,
       qty_inspection, qty_a_grade, qty_b_grade, qty_defect, rft, defect_rate, photo_count, changes)
     SELECT gen_random_uuid(), id, 1, sha256(id::text::bytea), $2, 'qip.digital', $3,
            sealed_at, inspection_date, username, factory, cell, po, article, model, destination, order_qty, podd,
            crd, partial_no, partial_qty, qty_rework, qty_bgrade_inspections, coalesce(qty_rework_approved, 0),
            qty_no_defect, 25, 25 - qty_defect, qty_b_grade, qty_defect,
            round((25 - qty_defect)::numeric / 25, 5), round(qty_defect::numeric / 25, 5), 0,
            '{"fields":[{"field":"counts.qtyInspection","old":30,"new":25}]}'
       FROM submissions WHERE id = $1`,
    [submissionUuid, rows[0]!.id, REASON],
  );

  // Opening Pengaturan looks for corrections (doc 05 §14).
  await page.getByRole('button', { name: 'Pengaturan' }).click();
  const list = page
    .getByRole('dialog', { name: 'Pengaturan' })
    .getByRole('region', { name: 'Pengiriman' });
  await expect(list).toContainText('Terkirim');
  await expect(list).toContainText('Dikoreksi admin');
  await expect(list).toContainText(REASON);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Home and the open session are untouched: a fresh session after SUBMIT PO.
  await expect(page.getByRole('region', { name: 'Hasil' })).not.toContainText('25');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'EXPORT EXCEL' }).click();
  const file = await download;
  const parts = unzipSync(new Uint8Array(await readFile(await file.path())));
  const workbook = Object.values(parts)
    .map((data) => strFromU8(data))
    .join('\n');
  expect(workbook).toContain('Correction');
  expect(workbook).toMatch(/Revisi 1, /);
  // Inspected Qty (Part II, row 9) is the corrected 25.
  expect(workbook).toContain('<c r="B9" s="5"><v>25</v></c>');

  // The outbox item itself is exactly what was sent.
  expect((await outbox(page))[0]!.payloadJson).toBe(sent!.payloadJson);
});
