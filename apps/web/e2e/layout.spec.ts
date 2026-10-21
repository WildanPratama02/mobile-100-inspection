// The three layouts of design-system/README.md and doc 05 §3, told apart by where the panes are (T1.8).
// Regular: landscape taller than 480 px. Compact: landscape 480 px or less. Stacked: portrait or 640 px or narrower.
import { type Locator, type Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { addPo, bar, login, openFamily, choice } from './helpers';
import { crowdedPills, undersized } from './tap';

type Layout = 'Regular' | 'Compact' | 'Stacked';

const LAYOUTS: Array<{ layout: Layout; width: number; height: number }> = [
  { layout: 'Regular', width: 1280, height: 800 },
  { layout: 'Compact', width: 915, height: 412 },
  { layout: 'Stacked', width: 800, height: 1280 },
];

const DEFECT = 'BROKEN STITCHING/LOOSE STITCHING/SKIPPED STITCHING/OPEN SEAM';

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, `${locator.toString()} has a box`).not.toBeNull();
  return {
    left: b!.x,
    top: b!.y,
    right: b!.x + b!.width,
    bottom: b!.y + b!.height,
    width: b!.width,
  };
}

/** Tap sizes, no sideways scroll, and a screenshot to look at. */
async function common(page: Page, what: string) {
  expect(await undersized(page), what).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `no sideways scroll: ${what}`,
  ).toBe(true);
  await page.screenshot({ path: `test-results/layout-${what}.png`, fullPage: true });
}

const pageScrolls = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 1);

for (const { layout, width, height } of LAYOUTS) {
  test(`${layout} at ${width}×${height}: Home and the Defect screen`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const viewportHeight = height;
    await page.goto('/');
    await login(page, 'DEWI CONTOH');
    await addPo(page, '0903359388');
    await addPo(page, 'CX-0902368685');

    // ---- Home (doc 05 §8.1) ----
    const poList = await box(page.getByRole('region', { name: 'PO LIST' }));
    const top5 = await box(page.getByRole('region', { name: 'TOP 5 DEFECT' }));
    const results = await box(page.getByRole('region', { name: 'Hasil' }));
    const add = await box(page.getByRole('button', { name: 'ADD DEFECT' }));
    const submit = await box(page.getByRole('button', { name: 'SUBMIT PO' }));
    const exportPdf = await box(page.getByRole('button', { name: 'EXPORT PDF' }));
    const pos = page
      .getByRole('region', { name: 'PO LIST' })
      .getByRole('button', { name: /^(0903359388|CX-)/ });
    const [po1, po2] = [await box(pos.nth(0)), await box(pos.nth(1))];
    const logo = page.locator('.home__header img');

    if (layout === 'Stacked') {
      // Info strip, PO list as a horizontal strip, results, Top 5; ADD DEFECT and SUBMIT PO in a bar at the
      // screen edge, the exports above the results.
      expect(po2.left, 'POs side by side').toBeGreaterThan(po1.right - 1);
      expect(Math.abs(po2.top - po1.top)).toBeLessThan(1);
      expect(poList.width).toBeGreaterThan(width * 0.9);
      expect(results.top).toBeGreaterThanOrEqual(poList.bottom - 1);
      expect(top5.top).toBeGreaterThanOrEqual(results.bottom - 1);
      expect(exportPdf.bottom).toBeLessThanOrEqual(results.top + 1);
      expect(Math.abs(add.top - submit.top)).toBeLessThan(1);
      expect(add.bottom).toBeGreaterThan(viewportHeight - 80);
      expect(add.bottom).toBeLessThanOrEqual(viewportHeight + 1);
    } else {
      // PO column on the left, Top 5 in the middle, results on the right, the action row along the bottom.
      expect(po2.top, 'POs one under the other').toBeGreaterThan(po1.bottom - 1);
      expect(top5.left).toBeGreaterThanOrEqual(poList.right - 1);
      expect(results.left).toBeGreaterThanOrEqual(top5.right - 1);
      expect(poList.width / width).toBeGreaterThan(0.15);
      expect(poList.width / width).toBeLessThan(0.3);
      for (const button of [add, exportPdf, submit]) {
        expect(button.top).toBeGreaterThanOrEqual(Math.max(top5.bottom, results.bottom) - 1);
        expect(Math.abs(button.top - add.top)).toBeLessThan(1);
      }
      // ADD DEFECT is the wide one: under the PO column and into the Top 5 column.
      expect(Math.abs(add.left - poList.left)).toBeLessThan(1);
      expect(add.right).toBeGreaterThan(top5.left);
      expect(add.width).toBeGreaterThan(exportPdf.width);
      expect(await pageScrolls(page), 'Home fits the screen').toBe(false);
    }
    // The header logo is hidden only in Compact (doc 05 §4a).
    if (layout === 'Compact') await expect(logo).toBeHidden();
    else await expect(logo).toBeVisible();
    await common(page, `home-${layout}`);

    // ---- Defect screen (doc 05 §11.1) ----
    await page.getByRole('button', { name: 'ADD DEFECT' }).click();
    await page.getByRole('button', { name: 'REWORK' }).click();
    await openFamily(page, 'QUARTER', 'Medial Quarter', 'Stitching');
    await choice(page, DEFECT).click();
    await expect(choice(page, DEFECT)).toContainText('1');

    const shoe = await box(page.getByRole('region', { name: 'Sepatu' }));
    const side = await box(page.getByRole('region', { name: 'Input defect' }));
    const nav = await box(page.getByRole('navigation', { name: 'Navigasi input defect' }));
    const history = await box(page.getByRole('region', { name: 'Riwayat defect' }));
    expect(await crowdedPills(page), 'shoe pills').toEqual([]);

    if (layout === 'Stacked') {
      // Shoe map on top, then the list and history; the bar stays at the screen edge.
      expect(side.top).toBeGreaterThanOrEqual(shoe.bottom - 1);
      expect(shoe.width).toBeGreaterThan(width * 0.9);
      expect(Math.abs(nav.bottom - viewportHeight)).toBeLessThan(1);
      await page.mouse.wheel(0, 2000);
      const scrolled = await box(page.getByRole('navigation', { name: 'Navigasi input defect' }));
      expect(Math.abs(scrolled.bottom - viewportHeight)).toBeLessThan(1);
    } else {
      // Shoe map pane about 56% on the left; list, history and BACK / HOME / UNDO on the right.
      expect(side.left).toBeGreaterThanOrEqual(shoe.right - 1);
      expect(shoe.width / width).toBeGreaterThan(0.5);
      expect(shoe.width / width).toBeLessThan(0.62);
      expect(nav.top).toBeGreaterThanOrEqual(history.bottom - 1);
      expect(Math.abs(nav.bottom - side.bottom)).toBeLessThan(2);
      expect(await pageScrolls(page), 'Defect screen fits the screen').toBe(false);
    }
    // The short Compact map uses the compact pill docks (U13): TONGUE docks at y 70 of 720 instead of 130
    // (src/ui/shoeLayout.ts).
    const pills = page.getByRole('group', { name: 'Pilih area sepatu' }).getByRole('button');
    await expect(pills).toHaveCount(12);
    const map = await box(page.locator('.defect__map > .m100-shoemap'));
    const tongue = await box(pills.filter({ hasText: 'TONGUE' }));
    const tongueY = ((tongue.top + tongue.bottom) / 2 - map.top) / (map.bottom - map.top);
    if (layout === 'Compact') expect(tongueY).toBeCloseTo(70 / 720, 1);
    else expect(tongueY).toBeCloseTo(130 / 720, 1);
    await common(page, `defect-${layout}`);
    await bar(page, 'HOME').click();
  });
}
