// `test` for the admin specs against the real API (apps/web/e2e/api/testApi.ts). Each test gets its own admin
// account, made by the first admin through `POST /admin/admins`, so tests that lock, rename or deactivate never
// touch another test's account.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test as base, type Page } from '@playwright/test';
import pg from 'pg';
import { DATABASE_ENV, REPO_ROOT, apiPort } from '../../web/e2e/api/testApi';
import { addTablet, type Sql } from '../../web/e2e/fixtures';

export { expect };

/** The account global setup creates with `admin:create`. */
export const ROOT_ADMIN = { username: 'e2e-root', password: 'e2e-root-password-1' } as const;

export interface Account {
  id: number;
  username: string;
  password: string;
}

const api = () => `http://127.0.0.1:${String(apiPort())}/v1`;

/**
 * The API counts admin requests per client IP, 60 a minute (doc 03 §5.6), and trusts `X-Forwarded-For` from
 * loopback as it does from Caddy. Every test (and every helper call) gets its own address, as every web test gets
 * its own tablet, so parallel tests never share a budget.
 */
export function clientIp(): { 'X-Forwarded-For': string } {
  const [a = 0, b = 0, c = 0] = randomBytes(3);
  return { 'X-Forwarded-For': `10.${String(a)}.${String(b)}.${String(c || 1)}` };
}

/** A cookie header for the API, from a login over plain HTTP (the browser's Secure rule does not apply here). */
export async function adminCookie(username: string, password: string): Promise<string> {
  const response = await fetch(`${api()}/admin/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'm100-admin',
      ...clientIp(),
    },
    body: JSON.stringify({ username, password }),
  });
  if (response.status !== 204) {
    throw new Error(`login ${username}: ${String(response.status)} ${await response.text()}`);
  }
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith('m100_admin='));
  if (!cookie) throw new Error('no m100_admin cookie');
  return cookie.split(';')[0]!;
}

/** Calls the admin API as the first admin. */
export async function asRoot<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
  const cookie = await adminCookie(ROOT_ADMIN.username, ROOT_ADMIN.password);
  const response = await fetch(`${api()}/admin${path}`, {
    method,
    headers: {
      Cookie: cookie,
      'X-Requested-With': 'm100-admin',
      ...clientIp(),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${String(response.status)} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export async function newAccount(prefix = 'e2e'): Promise<Account> {
  const username = `${prefix}-${randomBytes(4).toString('hex')}`;
  const password = `pw-${randomBytes(8).toString('hex')}`;
  const created = await asRoot<{ id: number }>('POST', '/admins', { username, password });
  return { id: created.id, username, password };
}

/** Logs in through A0 and waits for A1. */
export async function signIn(page: Page, account: { username: string; password: string }) {
  await page.goto('/admin/');
  await page.getByLabel('Username').fill(account.username);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'MASUK' }).click();
  await expect(page.getByRole('heading', { name: 'Submission', level: 1 })).toBeVisible();
}

/** The mapping bundled with the app, read as JSON (Playwright's loader cannot import it like `@m100/shared`). */
interface RawMapping {
  areas: { id: string; subs: { id: string; fams: [string, string[]][] }[] }[];
  defects: Record<string, { n: string; c: number; f: string }>;
}
const mapping = JSON.parse(
  readFileSync(join(REPO_ROOT, 'reference', 'mapping', 'mapping.json'), 'utf8'),
) as RawMapping;

function place(defectId: string) {
  for (const area of mapping.areas)
    for (const sub of area.subs)
      for (const [familyId, defects] of sub.fams)
        if (defects.includes(defectId)) return { areaId: area.id, subAreaId: sub.id, familyId };
  throw new Error(`${defectId} is not in the mapping`);
}

export const defectName = (id: string) => mapping.defects[id]!.n;

/** A JPEG-signed part; the API checks the signature only. */
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2000)]);

export interface Sent {
  id: string;
  displayNo: string;
  po: string;
  defects: string[];
}

/** WIB ISO 8601 of now minus `secondsAgo`, as the tablet sends its moments. */
function wib(secondsAgo = 0): string {
  return new Date(Date.now() - secondsAgo * 1000 + 7 * 3600_000)
    .toISOString()
    .replace('Z', '+07:00');
}

/**
 * One PSI lv.2 submission of DEWI CONTOH on F 3 / F3-10, PO 0903359388, sealed now (today's default filter), with
 * two defects and their two photos, sent through the tablet API like the outbox does.
 */
export async function sendSubmission(sql: Sql): Promise<Sent> {
  const tablet = await addTablet(sql);
  const login = await fetch(`${api()}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Key': tablet.key },
    body: JSON.stringify({
      username: 'DEWI CONTOH',
      level: 'PSI lv.2',
      factory: 'F 3',
      cell: 'F3-10',
    }),
  });
  if (!login.ok) throw new Error(`tablet login: ${String(login.status)} ${await login.text()}`);
  const { token } = (await login.json()) as { token: string };

  const defects = ['D035', 'D027'];
  const photos = defects.map((defectId) => ({ defectId, part: `photo_${defectId}`, jpeg: jpeg() }));
  const submissionUuid = randomUUID();
  const sealedAt = wib();
  const body = {
    submissionUuid,
    sealedAt,
    appVersion: '1.0.0',
    user: { username: 'DEWI CONTOH', level: 'PSI lv.2' },
    factory: 'F 3',
    cell: 'F3-10',
    po: '0903359388',
    partial: null,
    counts: { rework: 2, bGrade: 1, noDefect: 3 },
    findings: [
      {
        inspectionType: 'REWORK',
        ...place('D035'),
        defectId: 'D035',
        qty: 2,
        firstRecordedAt: wib(60),
      },
      {
        inspectionType: 'B-GRADE',
        ...place('D027'),
        defectId: 'D027',
        qty: 1,
        firstRecordedAt: wib(30),
      },
    ],
    photos: photos.map((p) => ({
      defectId: p.defectId,
      part: p.part,
      sha256: createHash('sha256').update(p.jpeg).digest('hex'),
    })),
  };
  const form = new FormData();
  form.append('submission', new Blob([JSON.stringify(body)], { type: 'application/json' }));
  for (const p of photos)
    form.append(p.part, new Blob([p.jpeg], { type: 'image/jpeg' }), `${p.defectId}.jpg`);
  const response = await fetch(`${api()}/submissions`, {
    method: 'POST',
    headers: { 'X-Device-Key': tablet.key, Authorization: `Bearer ${token}` },
    body: form,
  });
  if (response.status !== 201) {
    throw new Error(`submission: ${String(response.status)} ${await response.text()}`);
  }
  const { displayNo } = (await response.json()) as { displayNo: string };
  return { id: submissionUuid, displayNo, po: body.po, defects };
}

export const test = base.extend<{ account: Account }, { sql: Sql }>({
  // eslint-disable-next-line no-empty-pattern
  extraHTTPHeaders: async ({}, use) => {
    await use(clientIp());
  },
  sql: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const url = process.env[DATABASE_ENV];
      if (!url) throw new Error(`${DATABASE_ENV} is not set: global setup did not start the API`);
      const pool = new pg.Pool({
        connectionString: url,
        max: 2,
        application_name: 'm100 admin e2e',
      });
      await use((text, values) => pool.query(text, values));
      await pool.end();
    },
    { scope: 'worker' },
  ],
  // eslint-disable-next-line no-empty-pattern
  account: async ({}, use) => {
    await use(await newAccount());
  },
});

/** A problem answer for `page.route`, as the API sends it (doc 04 §6). */
export function problem(status: number, code: string, detail: string) {
  return {
    status,
    contentType: 'application/problem+json',
    body: JSON.stringify({
      type: 'about:blank',
      title: code,
      status,
      code,
      retryable: true,
      detail,
    }),
  };
}
