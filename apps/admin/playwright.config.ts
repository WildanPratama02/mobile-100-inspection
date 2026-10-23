import { defineConfig, devices } from '@playwright/test';

// Own ports, so the admin tests can run while the web tests (5173 / 3100) or a dev server hold theirs.
// E2E_ADMIN_PORT and E2E_API_PORT let a second checkout (git worktree) test at the same time.
const port = Number(process.env.E2E_ADMIN_PORT ?? 5176);
process.env.E2E_API_PORT ??= '3102';
const baseURL = `http://localhost:${port}`;
// The real API, started by global setup on its own test database (apps/web/e2e/api/testApi.ts); the dev server
// proxies `/v1` there.
const apiURL = `http://127.0.0.1:${process.env.E2E_API_PORT}`;

// Administrators sit at a laptop (doc 05 §20); a11y.spec.ts also checks the tablet sizes.
const laptop = {
  ...devices['Desktop Chrome'],
  viewport: { width: 1280, height: 800 },
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: './e2e/global-setup.ts',
  // The dev server compiles the app on its first page; give that time.
  expect: { timeout: 10_000 },
  use: {
    trace: 'retain-on-failure',
    baseURL,
  },
  projects: [{ name: 'admin', use: laptop }],
  webServer: {
    command: `pnpm dev --port ${port}`,
    env: { M100_API_URL: apiURL },
    url: `${baseURL}/admin/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
