import { expect, test } from '@playwright/test';
import { undersized } from './tap';

test.describe('/ui (dev UI kit)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/ui');
    await expect(page.getByRole('heading', { name: 'UI kit' })).toBeVisible();
  });

  test('shows every design-system component', async ({ page }) => {
    for (const name of [
      'Icon',
      'Button',
      'CommandButton',
      'BottomBar',
      'Chip',
      'CountBadge',
      'SelectField',
      'Dialog',
      'Toast',
      'Notice',
      'OutboxItem',
      'POListItem',
      'StatRow',
      'PhotoButton',
      'Top5Row',
      'OptionRow',
      'Breadcrumb',
      'HistoryRow',
      'AreaPill',
      'ShoeMap',
      'CheckboxRow',
      'Stepper',
      'NumberPad',
    ]) {
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    // List and Pane are the containers of the sections above.
    await expect(page.locator('.m100-list').first()).toBeVisible();
    await expect(page.locator('.m100-pane').first()).toBeVisible();
  });

  test('every tappable element is at least 44 × 44 px (tablet landscape)', async ({ page }) => {
    expect(await page.locator('button').count()).toBeGreaterThan(100);
    expect(await undersized(page)).toEqual([]);
  });

  test('every tappable element is at least 44 × 44 px (compact and stacked)', async ({ page }) => {
    for (const viewport of [
      { width: 740, height: 360 },
      { width: 400, height: 860 },
    ]) {
      await page.setViewportSize(viewport);
      expect(await undersized(page), `${viewport.width} × ${viewport.height}`).toEqual([]);
    }
  });

  test('ShoeMap renders the shoe photo with 12 pills at the design-system positions', async ({
    page,
  }) => {
    const photo = await page.request.get('/erasebg-transformed.avif');
    expect(photo.status()).toBe(200);
    expect(photo.headers()['content-type']).toContain('image/avif');

    const map = page.getByRole('group', { name: 'Pilih area sepatu', exact: true });
    await expect(map.locator('image')).toHaveAttribute('href', '/erasebg-transformed.avif');
    const pills = map.getByRole('button');
    await expect(pills).toHaveCount(12);

    // Pill docks in the 1000 × 720 map box (design-system/components/bundle.js SHOE_AREAS).
    const docks: Record<string, [number, number]> = {
      TONGUE: [170, 130],
      INSIDE: [170, 205],
      COLLAR: [170, 280],
      HEEL: [170, 355],
      'OUTSOLE / BONDING': [170, 560],
      'EYESTAY/LACE': [616, 80],
      VAMP: [830, 160],
      'TOE BOX': [830, 240],
      'BRANDING / TREATMENT': [830, 330],
      MIDSOLE: [830, 480],
      GENERAL: [830, 620],
      QUARTER: [400, 650],
    };
    const box = (await map.boundingBox())!;
    const placed = await pills.evaluateAll((els) =>
      els.map((el) => ({
        name: el.getAttribute('aria-label') ?? '',
        left: (el as HTMLElement).offsetLeft,
        top: (el as HTMLElement).offsetTop,
      })),
    );
    expect(placed.map((p) => p.name).sort()).toEqual(Object.keys(docks).sort());
    for (const p of placed) {
      const [x, y] = docks[p.name]!;
      expect(p.left, p.name).toBeCloseTo((x / 1000) * box.width, 0);
      expect(p.top, p.name).toBeCloseTo((y / 720) * box.height, 0);
    }

    // The photo has actually decoded (AVIF) and sits inside the map.
    const imageBox = (await map.locator('image').boundingBox())!;
    expect(imageBox.width).toBeGreaterThan(box.width * 0.5);
  });

  test('ShoeMap selects a tapped area and greys every pill while disabled', async ({ page }) => {
    const map = page.getByRole('group', { name: 'Pilih area sepatu', exact: true });
    const heel = map.getByRole('button', { name: 'HEEL' });
    await heel.click();
    await expect(heel).toHaveAttribute('aria-pressed', 'true');
    await expect(map.getByRole('button', { name: 'QUARTER' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    const off = page.getByRole('group', { name: 'Area sepatu nonaktif' });
    const offPills = off.getByRole('button');
    await expect(offPills).toHaveCount(12);
    for (const pill of await offPills.all()) await expect(pill).toBeDisabled();
  });

  test('switches between light and dark themes', async ({ page }) => {
    const bg = () =>
      page.evaluate(() => getComputedStyle(document.body).getPropertyValue('background-color'));
    await page.getByRole('button', { name: 'Terang' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const light = await bg();
    await page.getByRole('button', { name: 'Gelap' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await bg()).not.toBe(light);
    expect(await bg()).toBe('rgb(15, 18, 22)');
  });

  test('uses the self-hosted fonts', async ({ page }) => {
    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      const families = new Set<string>();
      document.fonts.forEach((face) => {
        if (face.status === 'loaded') families.add(face.family.replace(/"/g, ''));
      });
      return [...families].sort();
    });
    expect(loaded).toEqual(['Barlow Condensed', 'Barlow Semi Condensed', 'IBM Plex Mono']);
    const remote = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((url) => url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')),
    );
    expect(remote).toEqual([]);
  });
});
