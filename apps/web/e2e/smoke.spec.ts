import { expect, test } from '@playwright/test';

test('serves the app titled "Mobile 100% Inspection"', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Mobile 100% Inspection');
  await expect(page.getByRole('main')).toBeVisible();
});
