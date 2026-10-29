// Steps shared by the T1.8 specs: login, Add PO, the Defect screen and what Home and IndexedDB show.
import { expect, type Page } from '@playwright/test';

/** A RegExp that matches `text` at the start of an accessible name; defect names contain brackets. */
export const startsWith = (text: string) =>
  new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

async function pick(page: Page, field: 'Nama' | 'Factory' | 'Cell', option: string) {
  await page.getByRole('button', { name: new RegExp(`^${field}`) }).click();
  await page
    .getByRole('dialog')
    .getByRole('option', { name: startsWith(option) })
    .click();
}

/** Logs in on F 3 / F3-10 from the login screen. */
export async function login(page: Page, name: string) {
  await pick(page, 'Nama', name);
  await pick(page, 'Factory', 'F 3');
  await pick(page, 'Cell', 'F3-10');
  await page.getByRole('button', { name: 'LOGIN' }).click();
  await expect(page.getByRole('button', { name: 'Pengaturan' })).toBeVisible();
}

export async function logout(page: Page) {
  await page.getByRole('button', { name: 'Pengaturan' }).click();
  await page
    .getByRole('dialog', { name: 'Pengaturan' })
    .getByRole('button', { name: 'LOGOUT' })
    .click();
  // With unsubmitted POs the PSI confirms (AC-02.2).
  const warning = page.getByRole('alertdialog', { name: 'Keluar?' });
  if (await warning.isVisible()) await warning.getByRole('button', { name: 'LOGOUT' }).click();
  await expect(page.getByRole('heading', { name: 'Login PSI' })).toBeVisible();
}

export async function addPo(page: Page, po: string) {
  await page.getByRole('button', { name: 'Tambah PO' }).click();
  const dialog = page.getByRole('dialog', { name: 'Tambah PO' });
  await dialog.getByRole('button', { name: /^PO NUMBER/ }).click();
  await dialog.getByRole('searchbox').fill(po);
  await dialog.getByRole('option', { name: startsWith(po) }).click();
  await dialog.getByRole('button', { name: 'ADD TO PO LIST' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

export const toast = (page: Page) => page.getByRole('status');
export async function setQtyInspection(page: Page, qty: number) {
  await page.getByRole('button', { name: 'Ubah Qty Inspection' }).click();
  const dialog = page.getByRole('dialog', { name: 'QTY INSPECTION' });
  const pad = dialog.getByRole('group', { name: 'Qty inspection' });
  await pad.getByRole('button', { name: 'HAPUS', exact: true }).click();
  for (const digit of String(qty))
    await pad.getByRole('button', { name: digit, exact: true }).click();
  await dialog.getByRole('button', { name: 'SIMPAN' }).click();
  await expect(dialog).toHaveCount(0);
}
export const pill = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Pilih area sepatu' }).getByRole('button', { name });
export const choice = (page: Page, name: string) =>
  page.getByRole('region', { name: 'Pilihan' }).getByRole('button', { name: startsWith(name) });
export const bar = (page: Page, name: 'BACK' | 'HOME' | 'UNDO') =>
  page.getByRole('navigation', { name: 'Navigasi input defect' }).getByRole('button', { name });

/** On the Defect screen with an inspection active: drills down to a family (sub-areas and families by name). */
export async function openFamily(page: Page, area: string, subArea: string, family: string) {
  await pill(page, area).click();
  await choice(page, subArea).click();
  await choice(page, family).click();
}

/** The value beside a label in the results box on Home. */
export const stat = (page: Page, label: string) =>
  page
    .getByRole('region', { name: 'Hasil' })
    .locator('.m100-stat', { has: page.getByText(label, { exact: true }) })
    .locator('b');

export const top5 = (page: Page) => page.getByRole('region', { name: 'TOP 5 DEFECT' });

/** Every value of the results box on Home, in order (FR-04). */
export async function expectResults(
  page: Page,
  values: {
    po: string;
    inspection: string;
    defect: string;
    aGrade: string;
    bGrade: string;
    defectRate: string;
    passRate: string;
  },
) {
  await expect(stat(page, 'Qty PO Order')).toHaveText(values.po);
  await expect(stat(page, 'Qty Inspection')).toHaveText(values.inspection);
  await expect(stat(page, 'Qty Defect')).toHaveText(values.defect);
  await expect(stat(page, 'Qty A-Grade')).toHaveText(values.aGrade);
  await expect(stat(page, 'Qty B-Grade')).toHaveText(values.bGrade);
  await expect(stat(page, 'Defect Rate')).toHaveText(values.defectRate);
  await expect(stat(page, 'Pass Rate (RFT)')).toHaveText(values.passRate);
}

/** Top 5 rows, best first: number, name, classification and quantity (FR-05). */
export async function expectTop5(
  page: Page,
  rows: Array<[name: string, classification: 'MINOR' | 'MAJOR' | 'CRITICAL', qty: number]>,
) {
  const items = top5(page).getByRole('listitem');
  await expect(items).toHaveCount(rows.length);
  for (const [i, [name, classification, qty]] of rows.entries()) {
    await expect(items.nth(i).locator('.m100-t5__no')).toHaveText(String(i + 1));
    await expect(items.nth(i)).toContainText(name);
    await expect(items.nth(i)).toContainText(classification);
    await expect(items.nth(i).locator('.m100-t5__q')).toHaveText(String(qty));
  }
}

export interface OutboxItem {
  po: string;
  state: string;
  authorUsername: string;
  payloadJson: string;
}

/** The outbox rows in IndexedDB. */
export function outbox(page: Page): Promise<OutboxItem[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('m100');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
    const rows = await new Promise<OutboxItem[]>((resolve, reject) => {
      const request = db.transaction('outbox').objectStore('outbox').getAll();
      request.onsuccess = () => resolve(request.result as OutboxItem[]);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
    db.close();
    return rows.map(({ po, state, authorUsername, payloadJson }) => ({
      po,
      state,
      authorUsername,
      payloadJson,
    }));
  });
}
