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
