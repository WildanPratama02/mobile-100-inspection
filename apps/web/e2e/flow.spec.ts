import { expect, test } from './fixtures';
import {
  addPo,
  bar,
  choice,
  expectResults,
  login,
  openFamily,
  outbox,
  setQtyInspection,
} from './helpers';
import { undersized } from './tap';

const PO = '0903359388';
const BROKEN = 'BROKEN STITCHING/LOOSE STITCHING/SKIPPED STITCHING/OPEN SEAM';
const THREAD = 'THREAD ENDS (>2mm)';

for (const qty of [null, 2]) {
  test(`impossible partial with quantity ${qty} cannot seal or synchronize`, async ({
    page,
    sql,
    tablet,
  }) => {
    await page.goto('/');
    await login(page, 'ANDI CONTOH');
    await addPo(page, PO);
    if (qty !== null) await setQtyInspection(page, qty);
    await page.getByRole('button', { name: 'PO PARTIAL', exact: true }).click();
    const partial = page.getByRole('dialog', { name: 'PO Partial' });
    await partial.getByRole('checkbox', { name: /PO PARTIAL/ }).check();
    await partial
      .getByRole('group', { name: 'Qty partial' })
      .getByRole('button', { name: '2', exact: true })
      .click();
    await partial.getByRole('button', { name: 'SIMPAN' }).click();
    await expect(partial).toHaveCount(0);
    await page.getByRole('button', { name: 'ADD DEFECT' }).click();
    await page.getByRole('button', { name: 'REWORK', exact: true }).click();
    await openFamily(page, 'QUARTER', 'Medial Quarter', 'Stitching');
    for (let i = 0; i < 3; i++) await choice(page, BROKEN).click();
    await page.getByRole('button', { name: 'END INSPECTION' }).click();
    await bar(page, 'HOME').click();
    await expect(page.getByText(/3 defect tercatat, melebihi partial 2 pasang/)).toBeVisible();
    await page.getByRole('button', { name: 'SUBMIT PO' }).click();
    await expect(page.getByRole('dialog', { name: 'Submit PO', exact: true })).toHaveCount(0);
    // IMPOSSIBLE before EMPTY (doc 05 §13.1), with or without a Qty Inspection entered.
    await expect(
      page.getByRole('alertdialog', { name: 'Defect melebihi jumlah pasang' }),
    ).toBeVisible();
    await expect(page.getByRole('alertdialog', { name: 'QTY INSPECTION belum diisi' })).toHaveCount(
      0,
    );
    expect(await outbox(page)).toEqual([]);
    expect(
      (
        await sql(
          'SELECT count(*)::int AS n FROM submissions s JOIN devices d ON d.id=s.device_id WHERE d.label=$1',
          [tablet.label],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  });
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 915, height: 412 },
  { width: 800, height: 1280 },
]) {
  test(`Qty Inspection editor has 44px targets at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await login(page, 'ANDI CONTOH');
    await addPo(page, PO);
    expect(await undersized(page)).toEqual([]);
    await page.getByRole('button', { name: 'Ubah Qty Inspection' }).click();
    expect(await undersized(page)).toEqual([]);
    await page.screenshot({
      path: `test-results/qty-inspection-${viewport.width}x${viewport.height}.png`,
    });
  });
}

test('ADR-019: partial PO, three findings, manual Qty Inspection and real submission', async ({
  page,
  sql,
  tablet,
}) => {
  await page.goto('/');
  await login(page, 'ANDI CONTOH');
  await addPo(page, PO);
  await page.getByRole('button', { name: 'PO PARTIAL', exact: true }).click();
  const partial = page.getByRole('dialog', { name: 'PO Partial' });
  await partial.getByRole('checkbox', { name: /PO PARTIAL/ }).check();
  const partialPad = partial.getByRole('group', { name: 'Qty partial' });
  await partialPad.getByRole('button', { name: '3', exact: true }).click();
  await partialPad.getByRole('button', { name: '0', exact: true }).click();
  await partial.getByRole('button', { name: 'SIMPAN' }).click();
  await expect(partial).toHaveCount(0);
  for (const [type, defects] of [
    ['REWORK', [BROKEN, THREAD]],
    ['B-GRADE', [BROKEN]],
  ] as const) {
    await page.getByRole('button', { name: 'ADD DEFECT' }).click();
    await expect(page.getByRole('button', { name: 'NO DEFECT', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: type, exact: true }).click();
    await openFamily(page, 'QUARTER', 'Medial Quarter', 'Stitching');
    for (const name of defects) await choice(page, name).click();
    await page.getByRole('button', { name: 'END INSPECTION' }).click();
    await expect(bar(page, 'UNDO')).toBeDisabled();
    await bar(page, 'HOME').click();
  }
  await expectResults(page, {
    po: '10.002',
    inspection: '—',
    defect: '3',
    aGrade: '0',
    bGrade: '1',
    defectRate: '0,0%',
    passRate: '0,0%',
  });
  await page.getByRole('button', { name: 'Ubah Qty Inspection' }).click();
  const dialog = page.getByRole('dialog', { name: 'QTY INSPECTION' });
  await dialog.getByRole('button', { name: '2', exact: true }).click();
  await expect(dialog).toContainText('Minimal 3 pasang');
  await expect(dialog.getByRole('button', { name: 'SIMPAN' })).toBeDisabled();
  expect(await undersized(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'BATAL' }).click();
  await setQtyInspection(page, 30);
  await page.reload();
  await expectResults(page, {
    po: '10.002',
    inspection: '30',
    defect: '3',
    aGrade: '27',
    bGrade: '1',
    defectRate: '10,0%',
    passRate: '90,0%',
  });
  await page.getByRole('button', { name: 'SUBMIT PO' }).click();
  await page
    .getByRole('dialog', { name: 'Submit PO' })
    .getByRole('button', { name: 'KIRIM' })
    .click();
  await expect
    .poll(
      async () =>
        (
          await sql(
            'SELECT s.qty_inspection, s.qty_defect, s.qty_a_grade, s.counting_rule FROM submissions s JOIN devices d ON d.id = s.device_id WHERE d.label = $1',
            [tablet.label],
          )
        ).rows,
    )
    .toEqual([{ qty_inspection: 30, qty_defect: 3, qty_a_grade: 27, counting_rule: 'ADR-019' }]);
});
