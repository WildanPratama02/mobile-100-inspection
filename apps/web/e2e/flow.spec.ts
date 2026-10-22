// The whole Phase 1 flow, every number on Home checked after each step (T1.8; BR-01, BR-02, FR-04 … FR-08, FR-11).
import { type Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  addPo,
  bar,
  choice,
  expectResults,
  expectTop5,
  login,
  openFamily,
  outbox,
  toast,
  top5,
} from './helpers';

const PO = '0903359388';
// Quarter › Medial Quarter › Stitching (reference/mapping/mapping.json).
const BROKEN = 'BROKEN STITCHING/LOOSE STITCHING/SKIPPED STITCHING/OPEN SEAM'; // MAJOR
const THREAD = 'THREAD ENDS (>2mm)'; // MINOR

async function tapDefect(page: Page, name: string, qty: number) {
  await choice(page, name).click();
  await expect(choice(page, name)).toContainText(String(qty));
}

test('login → add PO → REWORK 2 defects → B-GRADE 1 defect → NO DEFECT → UNDO → SUBMIT PO', async ({
  page,
}) => {
  // Up to the seal: the API is never reached, so the submission stays Menunggu (sending: outbox.spec.ts).
  await page.context().route('**/v1/submissions', (route) => route.abort('internetdisconnected'));
  await page.goto('/');
  // PSI lv.1: no photo step before SUBMIT PO (AC-10.6); the PSI lv.2 path is in submit.spec.ts.
  await login(page, 'ANDI CONTOH');
  await addPo(page, PO);
  await expectResults(page, {
    po: '10.002',
    inspection: '0',
    defect: '0',
    aGrade: '0',
    bGrade: '0',
    defectRate: '—',
    passRate: '—',
  });
  await expect(top5(page)).toContainText('Belum ada defect');

  // REWORK with two defects, then END.
  await page.getByRole('button', { name: 'ADD DEFECT' }).click();
  await page.getByRole('button', { name: 'REWORK' }).click();
  await expect(toast(page)).toHaveText('Inspeksi REWORK dimulai');
  await openFamily(page, 'QUARTER', 'Medial Quarter', 'Stitching');
  await tapDefect(page, BROKEN, 1);
  await expect(toast(page)).toHaveText('+1 Defect');
  await tapDefect(page, THREAD, 1);
  await page.getByRole('button', { name: 'END INSPECTION' }).click();
  await expect(toast(page)).toHaveText('Inspeksi selesai. 2 defect tercatat');
  await bar(page, 'HOME').click();
  await expectResults(page, {
    po: '10.002',
    inspection: '1',
    defect: '2',
    aGrade: '0',
    bGrade: '0',
    defectRate: '200,0%',
    passRate: '0,0%',
  });
  // Equal quantities: MAJOR before MINOR (AC-05.1).
  await expectTop5(page, [
    [BROKEN, 'MAJOR', 1],
    [THREAD, 'MINOR', 1],
  ]);

  // B-GRADE with one defect: Qty Defect and Qty B-Grade +1 (ADR-008). END first: NO DEFECT is disabled while
  // an inspection is active (FR-06.2).
  await page.getByRole('button', { name: 'ADD DEFECT' }).click();
  await page.getByRole('button', { name: 'B-GRADE' }).click();
  await expect(page.getByRole('button', { name: 'NO DEFECT' })).toBeDisabled();
  await openFamily(page, 'QUARTER', 'Medial Quarter', 'Stitching');
  await tapDefect(page, BROKEN, 1);
  await expect(toast(page)).toHaveText('+1 Defect dan B-Grade');
  await page.getByRole('button', { name: 'END INSPECTION' }).click();
  await expect(toast(page)).toHaveText('Inspeksi selesai. 1 defect tercatat');
  await bar(page, 'HOME').click();
  await expectResults(page, {
    po: '10.002',
    inspection: '2',
    defect: '3',
    aGrade: '0',
    bGrade: '1',
    defectRate: '150,0%',
    passRate: '0,0%',
  });
  await expectTop5(page, [
    [BROKEN, 'MAJOR', 2],
    [THREAD, 'MINOR', 1],
  ]);

  // NO DEFECT: one A-Grade pair at once (FR-06.3).
  await page.getByRole('button', { name: 'ADD DEFECT' }).click();
  await page.getByRole('button', { name: 'NO DEFECT' }).click();
  await expect(toast(page)).toHaveText('No Defect tercatat. A-Grade +1');
  await bar(page, 'HOME').click();
  await expectResults(page, {
    po: '10.002',
    inspection: '3',
    defect: '3',
    aGrade: '1',
    bGrade: '1',
    defectRate: '100,0%',
    passRate: '33,3%',
  });

  // UNDO right after NO DEFECT cancels it (FR-08); going HOME in between starts nothing.
  await page.getByRole('button', { name: 'ADD DEFECT' }).click();
  await bar(page, 'UNDO').click();
  await expect(toast(page)).toHaveText('No Defect dibatalkan');
  // Nothing left to undo: the ended inspections are out of reach.
  await expect(bar(page, 'UNDO')).toBeDisabled();
  await bar(page, 'HOME').click();
  const beforeSubmit = {
    po: '10.002',
    inspection: '2',
    defect: '3',
    aGrade: '0',
    bGrade: '1',
    defectRate: '150,0%',
    passRate: '0,0%',
  };
  await expectResults(page, beforeSubmit);
  await expectTop5(page, [
    [BROKEN, 'MAJOR', 2],
    [THREAD, 'MINOR', 1],
  ]);

  // SUBMIT PO: the confirmation repeats Home's numbers, KIRIM seals into the outbox (FR-11 steps 1–3).
  await page.getByRole('button', { name: 'SUBMIT PO' }).click();
  const confirm = page.getByRole('dialog', { name: 'Submit PO' });
  await expect(confirm).toContainText(PO);
  await expect(confirm).toContainText(/Qty Inspection\s*2/);
  await expect(confirm).toContainText(/Qty Defect\s*3/);
  await expect(confirm).toContainText(/Defect Rate\s*150,0%/);
  await expect(confirm).toContainText(/Pass Rate \(RFT\)\s*0,0%/);
  await confirm.getByRole('button', { name: 'KIRIM' }).click();
  await expect(page.getByText('Tersimpan. Menunggu koneksi.')).toBeVisible();
  await expect(page.getByLabel(/pengiriman menunggu/)).toHaveText('1');

  // AC-04.2: every value back to 0 for the next session.
  await expectResults(page, {
    po: '10.002',
    inspection: '0',
    defect: '0',
    aGrade: '0',
    bGrade: '0',
    defectRate: '—',
    passRate: '—',
  });
  await expect(top5(page)).toContainText('Belum ada defect');

  const [item, ...rest] = await outbox(page);
  expect(rest).toEqual([]);
  expect(item).toMatchObject({ po: PO, state: 'waiting', authorUsername: 'ANDI CONTOH' });
  const payload = JSON.parse(item!.payloadJson) as {
    counts: object;
    findings: Array<{ qty: number }>;
  };
  // The UNDOne NO DEFECT is not in the submission.
  expect(payload.counts).toEqual({ rework: 1, bGrade: 1, noDefect: 0 });
  expect(payload.findings.reduce((n, f) => n + f.qty, 0)).toBe(3);
});
