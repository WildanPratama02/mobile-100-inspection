// The 3-step import of A4 and A5 (doc 05 §20.5, AC-14.3): choose file → dry-run report → Terapkan.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../web/e2e/api/testApi';
import { expect, signIn, test } from './fixtures';

const HEADER = 'PO,ARTICLE,MODEL,DESTINATION,ORDER QTY,PODD,CRD';
const csv = (rows: string[]) => ({
  name: 'ALL_PO_MASTER.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from([HEADER, ...rows].join('\n') + '\n', 'utf8'),
});

test('a PO file with an invalid row reports it and cannot be applied', async ({
  page,
  account,
}) => {
  const po = `IMP${randomBytes(4).toString('hex').toUpperCase()}`;
  await signIn(page, account);
  await page.goto('/admin/pos');
  await page.getByRole('button', { name: 'IMPOR CSV/XLSX' }).click();
  const dialog = page.getByRole('dialog', { name: 'Impor PO' });
  await expect(dialog.getByRole('listitem').filter({ hasText: '1. Pilih file' })).toHaveAttribute(
    'aria-current',
    'step',
  );
  await expect(dialog.getByRole('button', { name: 'Terapkan' })).toBeDisabled();

  await dialog
    .getByLabel('File')
    .setInputFiles(csv([`${po},A,M,JAPAN,100,2026-11-01,`, `${po}X,A,M,JAPAN,0,,`]));
  const report = dialog.getByRole('region', { name: 'Laporan impor' });
  await expect(report).toContainText('1 baris bermasalah');
  await expect(dialog.getByRole('region', { name: 'Masalah per baris' })).toContainText(
    'ORDER_QTY',
  );
  await expect(dialog.getByRole('listitem').filter({ hasText: '2. Laporan' })).toHaveAttribute(
    'aria-current',
    'step',
  );
  await expect(dialog.getByRole('button', { name: 'Terapkan' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'BATAL' }).click();

  // Nothing was written: the valid row of that file is not there either.
  await page.getByLabel('Cari PO / article / model').fill(po);
  await page.getByRole('button', { name: 'CARI' }).click();
  await expect(page.getByText(`Tidak ada PO untuk “${po}”.`)).toBeVisible();
});

test('a valid PO file: report, Terapkan, then a toast with the counts', async ({
  page,
  account,
}) => {
  const po = `IMP${randomBytes(4).toString('hex').toUpperCase()}`;
  await signIn(page, account);
  await page.goto('/admin/pos');
  await page.getByRole('button', { name: 'IMPOR CSV/XLSX' }).click();
  const dialog = page.getByRole('dialog', { name: 'Impor PO' });
  await dialog
    .getByLabel('File')
    .setInputFiles(
      csv([`${po},ART,MODEL,JAPAN,100,2026-11-01,2026-12-01`, `${po}B,ART,MODEL,USA,5,,`]),
    );
  const report = dialog.getByRole('region', { name: 'Laporan impor' });
  await expect(report).toContainText('Tidak ada masalah');
  await expect(report.getByRole('definition').nth(0)).toHaveText('2');
  await expect(report.getByRole('definition').nth(1)).toHaveText('2');
  await dialog.getByRole('button', { name: 'Terapkan' }).click();
  await expect(page.locator('.m100-toast')).toHaveText(
    'Impor selesai: 2 dibaca, 2 baru, 0 diubah, 0 dilewati.',
  );
  await expect(dialog).toHaveCount(0);

  await page.getByLabel('Cari PO / article / model').fill(po);
  await page.getByRole('button', { name: 'CARI' }).click();
  await expect(page.getByRole('row').filter({ hasText: `${po}B` })).toContainText('USA');
});

test('the mapping workbook: a dry run of the stored mapping has no errors', async ({
  page,
  account,
}) => {
  await signIn(page, account);
  await page.goto('/admin/defects');
  await page.getByRole('button', { name: 'IMPOR MAPPING' }).click();
  const dialog = page.getByRole('dialog', { name: 'Impor mapping area' });
  await dialog.getByLabel('File').setInputFiles({
    name: 'Footwear_Defect_Mapping_Database_v2.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: readFileSync(
      join(REPO_ROOT, 'reference', 'mapping', 'Footwear_Defect_Mapping_Database_v2.xlsx'),
    ),
  });
  await expect(dialog.getByRole('region', { name: 'Laporan impor' })).toContainText(
    'Tidak ada masalah',
  );
  await expect(dialog.getByRole('button', { name: 'Terapkan' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'BATAL' }).click();
  await expect(dialog).toHaveCount(0);
});

test('a file that is not a workbook is refused with the server problem', async ({
  page,
  account,
}) => {
  await signIn(page, account);
  await page.goto('/admin/defects');
  await page.getByRole('button', { name: 'IMPOR MAPPING' }).click();
  const dialog = page.getByRole('dialog', { name: 'Impor mapping area' });
  await dialog.getByLabel('File').setInputFiles({
    name: 'not-a-workbook.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('this is not a zip file'),
  });
  await expect(dialog.getByRole('alert').or(dialog.getByText('baris bermasalah'))).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Terapkan' })).toBeDisabled();
});
