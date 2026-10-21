// `test` for the specs that run against the real API (e2e/api/testApi.ts): every test gets its own registered
// tablet, so each has its own 60 requests a minute (doc 04 §7), and its page has been through the setup link
// (S0, doc 03 §4.9) before the test starts.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, test as base, type Page } from '@playwright/test';
import pg from 'pg';
import { DATABASE_ENV } from './api/testApi';

export { expect };

export interface Tablet {
  label: string;
  /** As `device:add` prints it: 32 random bytes in base64url. */
  key: string;
}

/** The test database, as superuser (the API's own grants are not what is tested here). */
export type Sql = <R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<pg.QueryResult<R>>;

/** Registers a tablet as `device:add` does: only the SHA-256 of the key is stored. */
export async function addTablet(sql: Sql): Promise<Tablet> {
  const key = randomBytes(32).toString('base64url');
  const label = `E2E ${randomUUID()}`;
  await sql('INSERT INTO devices (id, label, key_sha256) VALUES ($1, $2, $3)', [
    randomUUID(),
    label,
    createHash('sha256').update(key, 'utf8').digest(),
  ]);
  return { label, key };
}

/** Opens the setup link and waits for "Tablet terdaftar" (doc 05 §5). */
export async function setUp(page: Page, key: string): Promise<void> {
  await page.goto(`/setup#k=${key}`);
  await expect(page.getByRole('heading', { name: 'Tablet terdaftar' })).toBeVisible();
}

export const test = base.extend<{ tablet: Tablet }, { sql: Sql }>({
  sql: [
    // Playwright requires the destructuring pattern, also when the fixture uses no other fixture.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const url = process.env[DATABASE_ENV];
      if (!url) throw new Error(`${DATABASE_ENV} is not set: global setup did not start the API`);
      const pool = new pg.Pool({ connectionString: url, max: 2, application_name: 'm100 e2e' });
      await use((text, values) => pool.query(text, values));
      await pool.end();
    },
    { scope: 'worker' },
  ],
  tablet: async ({ sql }, use) => {
    await use(await addTablet(sql));
  },
  page: async ({ page, tablet }, use) => {
    await setUp(page, tablet.key);
    await use(page);
  },
});
