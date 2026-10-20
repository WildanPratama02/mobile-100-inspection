import type { Page } from '@playwright/test';

export const TAP_MIN = 44;

/** Every visible tappable element on the page that is smaller than 44 × 44 CSS px (doc 05 G2). */
export async function undersized(page: Page): Promise<string[]> {
  return page.evaluate((min) => {
    const tappable = document.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [role="button"], [role="checkbox"], [role="option"], [tabindex]:not([tabindex="-1"])',
    );
    return Array.from(tappable).flatMap((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return [];
      // Sub-pixel layout can round 44 down to 43.99.
      if (r.width >= min - 0.05 && r.height >= min - 0.05) return [];
      const name = el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName;
      return [`${name} (${r.width.toFixed(1)} × ${r.height.toFixed(1)})`];
    });
  }, TAP_MIN);
}

/**
 * Pairs of shoe-pane buttons (pills, commands, END INSPECTION) that cover each other, and pills that reach outside
 * the shoe pane (doc 05 G2, U13). A 1 px touch is allowed for sub-pixel layout.
 */
export async function crowdedPills(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const pane = document.querySelector('.defect__shoe')!.getBoundingClientRect();
    const boxes = Array.from(
      pane ? document.querySelectorAll<HTMLElement>('.defect__shoe button') : [],
    ).map((el) => ({
      name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
      pill: el.classList.contains('m100-pill'),
      r: el.getBoundingClientRect(),
    }));
    const problems: string[] = [];
    boxes.forEach((a, i) => {
      if (
        a.pill &&
        (a.r.left < pane.left - 1 ||
          a.r.right > pane.right + 1 ||
          a.r.top < pane.top - 1 ||
          a.r.bottom > pane.bottom + 1)
      ) {
        problems.push(`${a.name} outside the shoe pane`);
      }
      for (const b of boxes.slice(i + 1)) {
        const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (x > 1 && y > 1) problems.push(`${a.name} covers ${b.name}`);
      }
    });
    return problems;
  });
}
