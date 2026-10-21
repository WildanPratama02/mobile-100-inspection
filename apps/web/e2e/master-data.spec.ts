// T2.7 against the real API and its test database: the setup link (S0, doc 03 §4.9), master data from
// `GET /master-data` with its cache (AC-01.1–01.4, AC-13.1–13.4), login and token refresh, PO search.
import { randomUUID } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import { addPo, login, startsWith } from './helpers';
import { expect, test, type Sql } from './fixtures';

const NAME = (page: Page) => page.getByRole('button', { name: /^Nama/ });

/** One row of an IndexedDB store of the app's database `m100`. */
function idbGet<T>(page: Page, store: string, key: string): Promise<T | undefined> {
  return page.evaluate(
    async ([store, key]) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('m100');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
      });
      const row = await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
      });
      db.close();
      return row as T | undefined;
    },
    [store, key] as const,
  );
}

function idbPut(page: Page, store: string, row: unknown): Promise<void> {
  return page.evaluate(
    async ([store, row]) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('m100');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB'));
      });
      db.close();
    },
    [store, row] as const,
  );
}

/** A PSI only this test knows, added as an admin would add one: the master version goes up with it. */
async function addPsi(sql: Sql, level: 'PSI lv.1' | 'PSI lv.2' = 'PSI lv.1'): Promise<string> {
  const username = `E2E ${randomUUID().slice(0, 8).toUpperCase()}`;
  await sql('INSERT INTO psi_users (username, level) VALUES ($1, $2)', [username, level]);
  await bumpMasterVersion(sql);
  return username;
}

async function bumpMasterVersion(sql: Sql): Promise<void> {
  await sql(`UPDATE settings SET value = (value::bigint + 1)::text WHERE key = 'master_version'`);
}

async function pickName(page: Page, name: string) {
  await NAME(page).click();
  await page
    .getByRole('dialog')
    .getByRole('option', { name: startsWith(name) })
    .click();
}

/** A browser context without the setup link, as a tablet that was never registered. */
async function unregisteredPage(testInfo: TestInfo, browser: import('@playwright/test').Browser) {
  const context = await browser.newContext({ ...testInfo.project.use });
  return context.newPage();
}

test.describe('setup link (S0, doc 03 §4.9)', () => {
  test('stores the key, removes the fragment and leads to Login', async ({ page, tablet }) => {
    // The fixture opened /setup#k=<key> and waited for "Tablet terdaftar".
    expect(new URL(page.url()).hash).toBe('');
    expect(new URL(page.url()).pathname).toBe('/setup');
    expect(await idbGet(page, 'meta', 'deviceKey')).toEqual({
      key: 'deviceKey',
      value: tablet.key,
    });
    await page.getByRole('button', { name: 'Lanjut' }).click();
    await expect(page.getByRole('heading', { name: 'Login PSI' })).toBeVisible();
  });

  test('says an unknown key is invalid', async ({ page }) => {
    await page.goto(`/setup#k=${'x'.repeat(43)}`);
    await expect(
      page.getByText('Kunci tablet tidak valid. Minta tautan setup yang baru dari admin.'),
    ).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
  });

  test('a tablet without a key shows only "not registered"', async ({ browser }, testInfo) => {
    const page = await unregisteredPage(testInfo, browser);
    await page.goto('/');
    await expect(
      page.getByText('Tablet ini belum terdaftar. Buka tautan setup dari admin.'),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Login PSI' })).toHaveCount(0);
    await page.context().close();
  });

  test('a revoked tablet is refused at login (DEVICE_KEY_INVALID)', async ({
    page,
    sql,
    tablet,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Login PSI' })).toBeVisible();
    await sql('UPDATE devices SET revoked_at = now() WHERE label = $1', [tablet.label]);
    await pickName(page, 'DEWI CONTOH');
    await page.getByRole('button', { name: /^Factory/ }).click();
    await page.getByRole('dialog').getByRole('option', { name: 'F 1' }).click();
    await page.getByRole('button', { name: 'LOGIN' }).click();
    await expect(page.getByRole('alert')).toHaveText('Tablet belum terdaftar. Hubungi admin.');
  });
});

test.describe('login from master data (FR-01)', () => {
  test('lists only the PSI of the database, each with its level (AC-01.1)', async ({ page }) => {
    await page.goto('/');
    await NAME(page).click();
    const options = page.getByRole('dialog', { name: 'Pilih nama' }).getByRole('option');
    const texts = await options.allTextContents();
    for (const psi of [
      'ANDI CONTOHPSI lv.1',
      'BUNGA CONTOHPSI lv.1',
      'CAHYA CONTOHPSI lv.1',
      'DEWI CONTOHPSI lv.2',
      'EKO CONTOHPSI lv.2',
      'FAJAR CONTOHPSI lv.2',
    ]) {
      expect(texts).toContain(psi);
    }
    // CFA, T1QM and AQL3RD PARTY users are not imported; every name carries a PSI level.
    for (const other of ['GITA CONTOH', 'HADI CONTOH', 'INDAH CONTOH']) {
      expect(texts.some((t) => t.startsWith(other))).toBe(false);
    }
    expect(texts.every((t) => /PSI lv\.[12]$/.test(t))).toBe(true);
  });

  test('logs in through the API, keeps the token and survives a reload (AC-01.2, AC-01.3)', async ({
    page,
  }) => {
    await page.goto('/');
    await login(page, 'DEWI CONTOH');
    await expect(page.getByLabel('Akun')).toContainText('DEWI CONTOH');
    await expect(page.getByLabel('Info PO')).toContainText('F3-10');
    const auth = await idbGet<{ token: string; tokenExpiresAt: string }>(page, 'auth', 'current');
    expect(auth?.token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    const days = (Date.parse(auth!.tokenExpiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);

    await page.reload();
    await expect(page.getByLabel('Akun')).toContainText('DEWI CONTOH');
  });

  test("shows the API's detail for a PSI deactivated after the list was loaded", async ({
    page,
    sql,
  }) => {
    const name = await addPsi(sql);
    await page.goto('/');
    await pickName(page, name);
    await sql('UPDATE psi_users SET active = false WHERE username = $1', [name]);
    await page.getByRole('button', { name: /^Factory/ }).click();
    await page.getByRole('dialog').getByRole('option', { name: 'F 1' }).click();
    await page.getByRole('button', { name: 'LOGIN' }).click();
    await expect(page.getByRole('alert')).toHaveText('Nama tidak ada di daftar PSI.');
  });

  test('renews a token with fewer than 7 days left at the next start (doc 04 §2)', async ({
    page,
  }) => {
    await page.goto('/');
    await login(page, 'EKO CONTOH');
    const before = await idbGet<Record<string, unknown>>(page, 'auth', 'current');
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await idbPut(page, 'auth', { ...before, tokenExpiresAt: soon });
    const refreshed = page.waitForResponse(
      (r) => r.url().endsWith('/v1/auth/refresh') && r.status() === 200,
    );
    await page.reload();
    await refreshed;
    await expect
      .poll(
        async () =>
          (await idbGet<{ tokenExpiresAt: string }>(page, 'auth', 'current'))?.tokenExpiresAt,
      )
      .not.toBe(soon);
    const after = await idbGet<{ token: string; tokenExpiresAt: string }>(page, 'auth', 'current');
    expect(Date.parse(after!.tokenExpiresAt)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    await expect(page.getByLabel('Akun')).toContainText('EKO CONTOH');
  });
});

test.describe('master data cache (FR-13)', () => {
  test('first launch without master data says so and RETRY recovers (AC-01.4)', async ({
    page,
  }) => {
    await page.route('**/v1/master-data', (route) => route.abort('internetdisconnected'));
    await page.goto('/');
    await expect(
      page.getByText('Data awal belum bisa diunduh. Periksa Wi-Fi, lalu tekan RETRY.'),
    ).toBeVisible();
    await expect(NAME(page)).toHaveCount(0);
    await page.unroute('**/v1/master-data');
    await page.getByRole('button', { name: 'RETRY' }).click();
    await expect(page.getByRole('heading', { name: 'Login PSI' })).toBeVisible();
  });

  test('keeps working from the cached copy when the API fails (AC-13.1)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Login PSI' })).toBeVisible();
    await page.route('**/v1/master-data', (route) => route.abort('internetdisconnected'));
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Login PSI' })).toBeVisible();
    await NAME(page).click();
    await expect(
      page.getByRole('dialog').getByRole('option', { name: startsWith('DEWI CONTOH') }),
    ).toBeVisible();
  });

  test('asks with its ETag when it opens and gets 304 while nothing changed (AC-13.2)', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Login PSI' })).toBeVisible();
    const cached = await idbGet<{ etag: string }>(page, 'masterData', 'current');
    expect(cached?.etag).toMatch(/^"\d+"$/);
    const asked = page.waitForResponse((r) => r.url().endsWith('/v1/master-data'));
    await page.reload();
    const response = await asked;
    expect(await response.request().headerValue('if-none-match')).toBe(cached!.etag);
    expect(response.status()).toBe(304);
  });

  test('picks up a master change within 30 minutes while open (AC-13.2, AC-14.1)', async ({
    page,
    sql,
  }) => {
    await page.clock.install();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Login PSI' })).toBeVisible();
    const name = await addPsi(sql, 'PSI lv.2');
    const fetched = page.waitForResponse(
      (r) => r.url().endsWith('/v1/master-data') && r.status() === 200,
    );
    await page.clock.fastForward('30:00');
    await fetched;
    await NAME(page).click();
    await expect(
      page.getByRole('dialog').getByRole('option', { name: startsWith(name) }),
    ).toContainText('PSI lv.2');
  });

  test('shows when master data was last updated in the gear menu (AC-13.4)', async ({ page }) => {
    await page.goto('/');
    await login(page, 'DEWI CONTOH');
    await page.getByRole('button', { name: 'Pengaturan' }).click();
    await expect(page.getByRole('region', { name: 'Data' })).toHaveText(
      /^DataData master diperbarui \d{2} \w{3} \d{2}:\d{2}$/,
    );
  });
});

test.describe('PO search through the API (FR-03, AC-13.3)', () => {
  test('finds a PO by its last digits first, and says search needs a connection', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await login(page, 'DEWI CONTOH');
    await page.getByRole('button', { name: 'Tambah PO' }).click();
    const dialog = page.getByRole('dialog', { name: 'Tambah PO' });
    await dialog.getByRole('button', { name: /^PO NUMBER/ }).click();
    await dialog.getByRole('searchbox').fill('9388');
    await expect(dialog.getByRole('option').first()).toHaveAccessibleName(startsWith('0903359388'));

    await context.setOffline(true);
    await dialog.getByRole('searchbox').fill('8685');
    await expect(
      dialog.getByText('Cari PO butuh koneksi. Hubungkan Wi-Fi, lalu coba lagi.'),
    ).toBeVisible();
    await context.setOffline(false);
  });

  test('keeps the details of a listed PO on the tablet (AC-13.3)', async ({ page }) => {
    await page.goto('/');
    await login(page, 'DEWI CONTOH');
    await addPo(page, 'CX-0902368685');
    await page.route('**/v1/**', (route) => route.abort('internetdisconnected'));
    await page.reload();
    await expect(page.getByLabel('Info PO')).toContainText('CX-0902368685');
  });
});
