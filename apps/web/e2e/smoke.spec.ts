import { expect, test } from './fixtures';

test('serves the app titled "PSI Inspection Report" (ADR-022)', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('PSI Inspection Report');
  await expect(page.getByRole('main')).toBeVisible();
});
