// Touch targets ≥ 44 px, no sideways page scroll and keyboard-only use on every admin screen (doc 05 §19, §20,
// T3b.4). The admin is also used on a tablet browser, so the tablet sizes are checked too.
import type { Page } from '@playwright/test';
import { expect, sendSubmission, signIn, test } from './fixtures';

const TAP_MIN = 44;

/** Visible controls smaller than 44 × 44; a checkbox counts by its label, which is its tap target. */
async function undersized(page: Page): Promise<string[]> {
  return page.evaluate((min) => {
    const controls = document.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [role="tab"], [tabindex]:not([tabindex="-1"])',
    );
    return Array.from(controls).flatMap((el) => {
      const target =
        el instanceof HTMLInputElement && el.type === 'checkbox' ? (el.closest('label') ?? el) : el;
      const r = target.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return [];
      if (r.width >= min - 0.05 && r.height >= min - 0.05) return [];
      const name = el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName;
      return [`${name} (${r.width.toFixed(1)} × ${r.height.toFixed(1)})`];
    });
  }, TAP_MIN);
}

const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const SIZES = [
  { width: 1280, height: 800 },
  { width: 915, height: 412 },
  { width: 800, height: 1280 },
];

for (const size of SIZES) {
  test(`every screen at ${String(size.width)} × ${String(size.height)}`, async ({
    page,
    account,
    sql,
  }) => {
    const sent = await sendSubmission(sql);
    await page.setViewportSize(size);
    await signIn(page, account);

    const screens: [string, string][] = [
      ['/admin/', 'Submission'],
      [`/admin/submissions/${sent.id}`, sent.displayNo],
      ['/admin/psi-users', 'User PSI'],
      ['/admin/factories', 'Factory & cell'],
      ['/admin/pos', 'PO'],
      ['/admin/defects', 'Defect & area map'],
      ['/admin/admins', 'Admin'],
      ['/admin/audit-log', 'Audit log'],
    ];
    for (const [path, heading] of screens) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await expect(page.getByText('Memuat…')).toHaveCount(0);
      expect(await undersized(page), path).toEqual([]);
      expect(await sideways(page), path).toBeLessThanOrEqual(0);
    }

    // A dialog with a checkbox, and the small-screen menu.
    await page.goto('/admin/psi-users');
    await page
      .getByRole('button', { name: /^Ubah / })
      .first()
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await undersized(page), 'edit dialog').toEqual([]);
    await page.keyboard.press('Escape');
    if (size.width < 900) {
      await expect(page.getByRole('link', { name: 'Audit log' })).toBeHidden();
      await page.getByRole('button', { name: 'MENU' }).click();
      expect(await undersized(page), 'menu').toEqual([]);
      await page.getByRole('link', { name: 'Audit log' }).click();
      await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Admin', exact: true })).toBeHidden();
    }
  });
}

/** Presses Tab until the focused element has `name` as its accessible text; fails after `max` presses. */
async function tabTo(page: Page, name: string, max = 60) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(
      () =>
        document.activeElement?.getAttribute('aria-label') ??
        document.activeElement?.textContent?.trim() ??
        '',
    );
    if (focused === name) return;
  }
  throw new Error(`Tab never reached "${name}"`);
}

test('keyboard only: log in, move through the menu, open and close a dialog', async ({
  page,
  account,
}) => {
  await page.goto('/admin/');
  // The username field has focus; Tab goes to the password, Enter submits.
  await expect(page.getByLabel('Username')).toBeFocused();
  await page.keyboard.type(account.username);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password')).toBeFocused();
  await page.keyboard.type(account.password);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Submission', level: 1 })).toBeVisible();

  // The skip link comes first and moves focus to the content.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Lewati ke konten' })).toBeFocused();

  await tabTo(page, 'User PSI');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'User PSI', level: 1 })).toBeVisible();

  await tabTo(page, 'TAMBAH');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Tambah user PSI' });
  await expect(dialog.getByLabel('Nama')).toBeFocused();
  // Tab stays inside the dialog.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'TAMBAH' }).first()).toBeFocused();

  // A submission row opens with Enter on its link.
  await page.getByRole('link', { name: 'Submission', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Submission', level: 1 })).toBeVisible();
});
