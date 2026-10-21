import { defineConfig, devices } from '@playwright/test';

// E2E_PORT lets a second checkout (git worktree) test its own dev server while another one holds 5173.
const port = Number(process.env.E2E_PORT ?? 5173);
const baseURL = `http://localhost:${port}`;
// The service worker exists only in a build, so the PWA tests run against `vite preview` (E2E_PREVIEW_PORT likewise).
const previewPort = Number(process.env.E2E_PREVIEW_PORT ?? 4173);
const previewURL = `http://localhost:${previewPort}`;
// The real API, started by global setup on its own test database (e2e/api/testApi.ts); both servers proxy `/v1`
// there. E2E_API_PORT likewise lets two checkouts test at once.
const apiURL = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 3100}`;

// Target: Redmi Pad 2 in landscape, about 1280 × 800 CSS px (NFR-01).
const tablet = {
  ...devices['Desktop Chrome'],
  viewport: { width: 1280, height: 800 },
  hasTouch: true,
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'tablet-landscape',
      testIgnore: /pwa\.spec\.ts/,
      use: { ...tablet, baseURL },
    },
    {
      name: 'pwa',
      testMatch: /pwa\.spec\.ts/,
      use: { ...tablet, baseURL: previewURL },
    },
  ],
  webServer: [
    {
      command: `pnpm dev --port ${port}`,
      env: { M100_API_URL: apiURL },
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // Always a fresh build: a reused preview server could serve an old one.
      command: `pnpm build && pnpm preview --port ${previewPort} --strictPort`,
      env: { M100_API_URL: apiURL },
      url: previewURL,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
