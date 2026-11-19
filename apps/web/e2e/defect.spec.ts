// Defect screen: commands, shoe map, drill-down, history, BACK / HOME / UNDO (T1.4: FR-06 … FR-09, NFR-03).
import { type Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { crowdedPills, undersized } from './tap';

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 915, height: 412 },
  { width: 800, height: 1280 },
];

// Quarter › Medial Quarter › Stitching (reference/mapping/mapping.json).
const FAMILY = 'Stitching';
const DEFECT = 'BROKEN STITCHING/LOOSE STITCHING/SKIPPED STITCHING/OPEN SEAM';

async function pick(page: Page, field: 'Nama' | 'Factory' | 'Cell', option: string) {
  await page.getByRole('button', { name: new RegExp(`^${field}`) }).click();
  await page
    .getByRole('dialog')
    .getByRole('option', { name: new RegExp(`^${option}`) })
    .click();
}

/** Logs in, adds PO 0903359388 and opens the Defect screen. */
async function openDefectScreen(page: Page, name = 'DEWI CONTOH') {
  await page.goto('/');
  await pick(page, 'Nama', name);
  await pick(page, 'Factory', 'F 3');
  await pick(page, 'Cell', 'F3-10');
  await page.getByRole('button', { name: 'LOGIN' }).click();
  await page.getByRole('button', { name: 'Tambah PO' }).click();
  const dialog = page.getByRole('dialog', { name: 'Tambah PO' });
  await dialog.getByRole('button', { name: /^PO NUMBER/ }).click();
  await dialog.getByRole('searchbox').fill('0903359388');
  await dialog.getByRole('option', { name: /^0903359388/ }).click();
  await dialog.getByRole('button', { name: 'ADD TO PO LIST' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'INSPECTION', exact: true }).click();
  await expect(page.getByText('Mulai inspeksi')).toBeVisible();
}

const pill = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Pilih area sepatu' }).getByRole('button', { name });
const option = (page: Page, title: string | RegExp) =>
  page.getByRole('region', { name: 'Pilihan' }).getByRole('button', { name: title });
const bar = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Navigasi input defect' }).getByRole('button', { name });
const toast = (page: Page) => page.getByRole('status');

async function openStitching(page: Page) {
  await pill(page, 'QUARTER').click();
  await option(page, /^Medial Quarter/).click();
  await option(page, new RegExp(`^${FAMILY}`)).click();
}

const defectRow = (page: Page) =>
  page
    .getByRole('region', { name: 'Pilihan' })
    .getByRole('button', { name: new RegExp(`^${DEFECT}`) });

const END_HINT = 'Catat minimal 1 defect sebelum END INSPECTION.';

/** All results rows on Home (label and value), to compare before and after. */
const results = (page: Page) =>
  page.getByRole('region', { name: 'Hasil' }).locator('.m100-stat').allInnerTexts();

/** The value shown beside a results label on Home. */
const stat = (page: Page, label: string) =>
  page
    .getByRole('region', { name: 'Hasil' })
    .locator('.m100-stat', { hasText: label })
    .locator('b');

test('records a REWORK with two defects, survives a reload and updates Home (AC-06.2, AC-07, AC-09)', async ({
  page,
}) => {
  await openDefectScreen(page);
  await expect(pill(page, 'QUARTER')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'END INSPECTION' })).toBeDisabled();

  await page.getByRole('button', { name: 'REWORK' }).click();
  await expect(toast(page)).toHaveText('Inspeksi REWORK dimulai');
  await openStitching(page);
  await expect(page.getByRole('navigation', { name: 'Posisi' })).toContainText('Medial Quarter');
  await defectRow(page).click();
  await expect(toast(page)).toHaveText('+1 Defect');
  await defectRow(page).click();
  await expect(defectRow(page)).toContainText('2');
  await expect(pill(page, 'QUARTER')).toContainText('2');
  const history = page.getByRole('region', { name: 'Riwayat defect' }).getByRole('listitem');
  await expect(history).toHaveCount(1);
  await expect(history.first()).toContainText(`Quarter › Medial Quarter · ${FAMILY} · REWORK`);

  // AC-06.2: the inspection, the area path and the counts come back after a reload.
  await page.reload();
  await expect(page.getByRole('button', { name: 'REWORK' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(defectRow(page)).toContainText('2');
  await expect(history).toHaveCount(1);

  await page.getByRole('button', { name: 'END INSPECTION' }).click();
  await expect(toast(page)).toHaveText('Inspeksi selesai. 2 defect tercatat');
  await expect(page.getByText('Mulai inspeksi')).toBeVisible();

  // AC-06.3: END INSPECTION needs a defect of the current inspection; the list is per inspection.
  await page.getByRole('button', { name: 'B-GRADE' }).click();
  const end = page.getByRole('button', { name: 'END INSPECTION' });
  await expect(end).toBeDisabled();
  await expect(page.getByText(END_HINT)).toBeVisible();
  await expect(page.getByText('Belum ada defect tercatat untuk inspeksi ini.')).toBeVisible();
  await openStitching(page);
  await defectRow(page).click();
  await expect(toast(page)).toHaveText('+1 Defect dan B-Grade');
  await expect(end).toBeEnabled();
  await end.click();
  await expect(toast(page)).toHaveText('Inspeksi selesai. 1 defect tercatat');

  // PSI lv.2 (ADR-021): each ended pair counts, NO DEFECT adds an A-Grade pair.
  await page.getByRole('button', { name: 'NO DEFECT', exact: true }).click();
  await expect(toast(page)).toHaveText('No Defect tercatat. A-Grade +1');

  await bar(page, 'HOME').click();
  // 3 ended pairs (REWORK 2 defects, B-GRADE 1 defect, NO DEFECT 1 pair); BR-01/BR-02.
  await expect(stat(page, 'Qty Inspection')).toHaveText('3');
  await expect(stat(page, 'Qty Defect')).toHaveText('3');
  await expect(stat(page, 'Qty A-Grade')).toHaveText('1');
  await expect(stat(page, 'Qty B-Grade')).toHaveText('1');
  await expect(stat(page, 'Defect Rate')).toHaveText('100,0%');
  await expect(stat(page, 'Pass Rate (RFT)')).toHaveText('33,3%');
});

test('UNDO, BACK and the back gesture (FR-08)', async ({ page }) => {
  await openDefectScreen(page);
  await expect(bar(page, 'UNDO')).toBeDisabled();
  // PSI lv.2: UNDO right after NO DEFECT cancels that pair (ADR-021).
  await page.getByRole('button', { name: 'NO DEFECT', exact: true }).click();
  await bar(page, 'UNDO').click();
  await expect(toast(page)).toHaveText('No Defect dibatalkan');
  await expect(bar(page, 'UNDO')).toBeDisabled();

  await page.getByRole('button', { name: 'REWORK' }).click();
  await openStitching(page);
  await defectRow(page).click();
  await expect(defectRow(page)).toContainText('1');
  await bar(page, 'UNDO').click();
  await expect(toast(page)).toHaveText('Defect terakhir dibatalkan');
  await expect(page.getByText('Belum ada defect tercatat untuk inspeksi ini.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'END INSPECTION' })).toBeDisabled();
  await expect(page.getByText(END_HINT)).toBeVisible();

  // BACK and the Android back gesture (doc 05 §2) both go up: families, sub-areas, no area, then Home.
  await page.goBack();
  await expect(option(page, new RegExp(`^${FAMILY}`))).toBeVisible();
  await bar(page, 'BACK').click();
  await expect(option(page, /^Lateral Quarter/)).toBeVisible();
  await page.goBack();
  await expect(page.getByText('Pilih area sepatu')).toBeVisible();
  await bar(page, 'BACK').click();
  await expect(page.getByRole('button', { name: 'INSPECTION', exact: true })).toBeVisible();
  await expect(page.getByText(/^Inspeksi berjalan\./)).toBeVisible();

  // AC-06.3: UNDO of the empty start removes the inspection; no pair is counted (ADR-021).
  await page.getByRole('button', { name: 'INSPECTION', exact: true }).click();
  await bar(page, 'UNDO').click();
  await expect(toast(page)).toHaveText('Inspeksi dibatalkan');
  await expect(page.getByText('Mulai inspeksi')).toBeVisible();
  await expect(page.getByRole('button', { name: 'REWORK' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.getByText(END_HINT)).toHaveCount(0);
  await expect(bar(page, 'UNDO')).toBeDisabled();
  await bar(page, 'HOME').click();
  await expect(page.getByText(/^Inspeksi berjalan\./)).toHaveCount(0);
  await expect(stat(page, 'Qty Inspection')).toHaveText('0');
  await expect(stat(page, 'Qty Defect')).toHaveText('0');
  await expect(stat(page, 'INSPECTION REWORK QTY')).toHaveText('0');
});

test('PSI lv.2: NO DEFECT shows in the history; UNDO takes back extra taps one by one (FR-08, FR-09)', async ({
  page,
}) => {
  await openDefectScreen(page);
  const history = page.getByRole('region', { name: 'Riwayat defect' });
  const row = history.getByRole('listitem');
  // Since ADR-023 the NO DEFECT row is shown at 0 too.
  await expect(row).toHaveCount(1);
  await expect(row.locator('.m100-hist__q')).toHaveText('0');
  for (let i = 0; i < 3; i++)
    await page.getByRole('button', { name: 'NO DEFECT', exact: true }).click();
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('NO DEFECT');
  await expect(row.locator('.m100-hist__q')).toHaveText('3');

  // Two too many: UNDO twice, each takes back one pair.
  await bar(page, 'UNDO').click();
  await expect(row.locator('.m100-hist__q')).toHaveText('2');
  await bar(page, 'UNDO').click();
  await expect(row.locator('.m100-hist__q')).toHaveText('1');
  await expect(bar(page, 'UNDO')).toBeEnabled();

  await bar(page, 'HOME').click();
  await expect(stat(page, 'Qty A-Grade')).toHaveText('1');
  await expect(stat(page, 'Qty Inspection')).toHaveText('1');
});

test('a defect tap gives feedback within 100 ms (NFR-03, AC-07.2)', async ({ page }) => {
  await openDefectScreen(page);
  await page.getByRole('button', { name: 'REWORK' }).click();
  await openStitching(page);
  // One unmeasured tap first: the first run of a code path in a dev build is not what the PSI feels.
  await defectRow(page).click();
  await expect(defectRow(page)).toContainText('1');

  const flash: number[] = [];
  const count: number[] = [];
  for (let i = 2; i <= 6; i++) {
    const ms = await defectRow(page).evaluate(
      (row, expected) =>
        new Promise<{ flash: number; count: number }>((resolve) => {
          const list = row.parentElement!;
          const prefix = row.textContent.replace(/\d+$/, '');
          const t0 = performance.now();
          let flashAt = -1;
          const check = () => {
            // The tapped row is mounted again to replay its flash, so it is found by its text.
            const current = Array.from(list.children).find((el) =>
              el.textContent?.startsWith(prefix),
            );
            if (flashAt < 0 && current?.classList.contains('m100-flash')) {
              flashAt = performance.now() - t0;
            }
            if (current?.querySelector('.m100-row__q')?.textContent === String(expected)) {
              observer.disconnect();
              resolve({ flash: flashAt, count: performance.now() - t0 });
            }
          };
          const observer = new MutationObserver(check);
          observer.observe(list, { subtree: true, childList: true, characterData: true });
          (row as HTMLButtonElement).click();
          check();
        }),
      i,
    );
    flash.push(ms.flash);
    count.push(ms.count);
  }
  const report = `flash ${flash.map((t) => t.toFixed(1)).join(', ')} ms; count ${count
    .map((t) => t.toFixed(1))
    .join(', ')} ms`;
  // The flash is the feedback and comes in the frame of the tap; the count follows the IndexedDB write.
  for (const t of flash) expect(t, report).toBeGreaterThanOrEqual(0);
  expect(Math.max(...flash), report).toBeLessThan(100);
  const median = [...count].sort((a, b) => a - b)[Math.floor(count.length / 2)]!;
  expect(median, report).toBeLessThan(100);
  console.log(`NFR-03 ${report}`);
});

test('PSI lv.1: END INSPECTION waits for a defect and the list is per inspection (AC-06.3, FR-06)', async ({
  page,
}) => {
  await openDefectScreen(page, 'ANDI CONTOH');
  await expect(page.getByRole('button', { name: 'NO DEFECT', exact: true })).toHaveCount(0);

  const end = page.getByRole('button', { name: 'END INSPECTION' });
  await page.getByRole('button', { name: 'REWORK' }).click();
  await expect(toast(page)).toHaveText('Inspeksi REWORK dimulai');
  await expect(end).toBeDisabled();
  await expect(page.getByText(END_HINT)).toBeVisible();
  await expect(page.getByText('Belum ada defect tercatat untuk inspeksi ini.')).toBeVisible();

  await openStitching(page);
  await defectRow(page).click();
  await expect(toast(page)).toHaveText('+1 Defect');
  const history = page.getByRole('region', { name: 'Riwayat defect' }).getByRole('listitem');
  await expect(history).toHaveCount(1);
  await expect(end).toBeEnabled();
  await expect(page.getByText(END_HINT)).toHaveCount(0);

  await end.click();
  await expect(toast(page)).toHaveText('Inspeksi selesai. 1 defect tercatat');

  await bar(page, 'HOME').click();
  await expect(stat(page, 'Qty Defect')).toHaveText('1');
  const before = await results(page);
  await page.getByRole('button', { name: 'INSPECTION', exact: true }).click();

  // A new inspection starts with an empty list; the ended one stays on Home.
  await page.getByRole('button', { name: 'B-GRADE' }).click();
  await expect(toast(page)).toHaveText('Inspeksi B-GRADE dimulai');
  await expect(history).toHaveCount(0);
  await expect(page.getByText('Belum ada defect tercatat untuk inspeksi ini.')).toBeVisible();
  await expect(end).toBeDisabled();

  // UNDO of the only defect disables END INSPECTION again.
  await openStitching(page);
  await defectRow(page).click();
  await expect(toast(page)).toHaveText('+1 Defect dan B-Grade');
  await expect(end).toBeEnabled();
  await bar(page, 'UNDO').click();
  await expect(toast(page)).toHaveText('Defect terakhir dibatalkan');
  await expect(history).toHaveCount(0);
  await expect(end).toBeDisabled();
  await expect(page.getByText(END_HINT)).toBeVisible();

  // UNDO of the start removes the inspection; Home totals are as before it.
  await bar(page, 'UNDO').click();
  await expect(toast(page)).toHaveText('Inspeksi dibatalkan');
  await expect(page.getByText('Mulai inspeksi')).toBeVisible();
  await expect(page.getByText(END_HINT)).toHaveCount(0);
  await expect(bar(page, 'UNDO')).toBeDisabled();
  await bar(page, 'HOME').click();
  await expect(page.getByText(/^Inspeksi berjalan\./)).toHaveCount(0);
  expect(await results(page)).toEqual(before);
});

for (const viewport of VIEWPORTS) {
  test(`Defect screen fits ${viewport.width} × ${viewport.height} with ≥ 44 px targets`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const label = `${viewport.width}x${viewport.height}`;
    const check = async (what: string) => {
      expect(await undersized(page), `${what} ${label}`).toEqual([]);
      expect(await crowdedPills(page), `shoe map ${what} ${label}`).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `no sideways scroll: ${what} ${label}`,
      ).toBe(true);
      await page.screenshot({ path: `test-results/defect-${what}-${label}.png` });
    };

    await openDefectScreen(page);
    await check('idle');
    await page.getByRole('button', { name: 'REWORK' }).click();
    // AC-06.3: an active inspection with no defect shows the hint under END INSPECTION.
    await expect(page.getByText(END_HINT)).toBeVisible();
    await check('no-defect');
    await openStitching(page);
    await defectRow(page).click();
    await expect(defectRow(page)).toContainText('1');
    await check('defects');
  });
}
