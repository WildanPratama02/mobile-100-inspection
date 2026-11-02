// `test` for the admin specs against the real API (apps/web/e2e/api/testApi.ts). Each test gets its own admin
// account, made by the first admin through `POST /admin/admins`, so tests that lock, rename or deactivate never
// touch another test's account.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test as base, type Page } from '@playwright/test';
import pg from 'pg';
import type { CountingRule } from '@m100/shared';
import { DATABASE_ENV, PHOTO_DIR_ENV, REPO_ROOT, apiPort } from '../../web/e2e/api/testApi';
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

/** ADR-022 fields and the level a payload may carry; the ADR-022 fields stay absent (legacy NULL rows) by default. */
export interface SubmissionExtras {
  /** `PSI lv.1` sends no photo and stores `photo_rule` NULL even without this field. */
  level?: 'PSI lv.1';
  reworkApproved?: number;
  photoRule?: 'ALL';
  /** More defects after D035 and D027, one REWORK finding of qty 1 each (and, at PSI lv.2, one photo each). */
  extraDefects?: string[];
  /** NO DEFECT taps of an ADR-008 payload; 3 by default. */
  noDefect?: number;
}

/** WIB ISO 8601 of now minus `secondsAgo`, as the tablet sends its moments. */
function wib(secondsAgo = 0): string {
  return new Date(Date.now() - secondsAgo * 1000 + 7 * 3600_000)
    .toISOString()
    .replace('Z', '+07:00');
}

/**
 * One submission on F 3 / F3-10, PO 0903359388, sealed now (today's default filter), with two defects (and two
 * photos) plus `extras.extraDefects`, sent through the tablet API like the outbox does. PSI lv.2 of DEWI CONTOH by default; `extras.level`
 * makes it a PSI lv.1 row of ANDI CONTOH with no photo at all (each level logs in from its own roster). The
 * ADR-022 `extras` fields (doc 04 A19) stay absent by default, so the stored row keeps them NULL like a row
 * sealed before migration 0007.
 */
export async function sendSubmission(
  sql: Sql,
  rule: CountingRule = 'ADR-008',
  extras: SubmissionExtras = {},
): Promise<Sent> {
  const tablet = await addTablet(sql);
  const lv1 = extras.level === 'PSI lv.1';
  const login = await fetch(`${api()}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Key': tablet.key },
    body: JSON.stringify({
      username: lv1 ? 'ANDI CONTOH' : 'DEWI CONTOH',
      level: lv1 ? 'PSI lv.1' : 'PSI lv.2',
      factory: 'F 3',
      cell: 'F3-10',
    }),
  });
  if (!login.ok) throw new Error(`tablet login: ${String(login.status)} ${await login.text()}`);
  const { token } = (await login.json()) as { token: string };

  const defects = ['D035', 'D027', ...(extras.extraDefects ?? [])];
  // PSI lv.1 sends no photo (AC-10.6), so its body carries an empty photos list and no photo parts.
  const photos =
    extras.level === 'PSI lv.1'
      ? []
      : defects.map((defectId) => ({ defectId, part: `photo_${defectId}`, jpeg: jpeg() }));
  const submissionUuid = randomUUID();
  const sealedAt = wib();
  const body = {
    submissionUuid,
    sealedAt,
    appVersion: '1.0.0',
    user: { username: lv1 ? 'ANDI CONTOH' : 'DEWI CONTOH', level: lv1 ? 'PSI lv.1' : 'PSI lv.2' },
    factory: 'F 3',
    cell: 'F3-10',
    po: '0903359388',
    partial: null,
    counts: {
      ...(rule === 'ADR-019'
        ? { rework: 2, bGrade: 1, qtyInspection: 30 }
        : { rework: 2, bGrade: 1, noDefect: extras.noDefect ?? 3 }),
      ...(extras.reworkApproved === undefined ? {} : { reworkApproved: extras.reworkApproved }),
    },
    ...(extras.photoRule === undefined ? {} : { photoRule: extras.photoRule }),
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
      ...(extras.extraDefects ?? []).map((defectId) => ({
        inspectionType: 'REWORK',
        ...place(defectId),
        defectId,
        qty: 1,
        firstRecordedAt: wib(45),
      })),
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

/**
 * A PSI lv.2 row as it was stored before migration 0007 (ADR-022 decision 4 amendment): a copy of `sent` under a
 * new id with `qty_rework_approved` and `photo_rule` NULL, plus its findings and photos (files copied to new keys).
 * The API can no longer write such a row (a new PSI lv.2 insert stores `TOP5` or `ALL`, doc 02 §4.1), so the test
 * inserts it directly; submissions are only ever inserted, never changed (BR-07).
 */
export async function copyAsPre0007(sql: Sql, sent: Sent): Promise<Sent> {
  const dir = process.env[PHOTO_DIR_ENV];
  if (!dir) throw new Error(`${PHOTO_DIR_ENV} is not set: global setup did not start the API`);
  const id = randomUUID();
  const columns = `payload_sha256, sealed_at, inspection_date, app_version, device_id, username, level, factory,
    cell, po, article, model, destination, order_qty, podd, crd, partial_no, partial_qty, qty_rework,
    qty_bgrade_inspections, qty_no_defect, qty_inspection, qty_a_grade, qty_b_grade, qty_defect, rft, defect_rate,
    photo_count, counting_rule`;
  const { rows } = await sql<{ display_no: string }>(
    `INSERT INTO submissions (id, ${columns}, qty_rework_approved, photo_rule)
     SELECT $2, ${columns}, NULL, NULL FROM submissions WHERE id = $1 AND level = 'PSI lv.2'
     RETURNING display_no::text`,
    [sent.id, id],
  );
  if (rows.length !== 1) throw new Error(`no PSI lv.2 submission ${sent.id} to copy`);
  await sql(
    `INSERT INTO submission_findings (submission_id, inspection_type, area_id, sub_area_id, family_id, defect_id,
       defect_name, severity, qty, first_recorded_at)
     SELECT $2, inspection_type, area_id, sub_area_id, family_id, defect_id, defect_name, severity, qty,
       first_recorded_at
     FROM submission_findings WHERE submission_id = $1`,
    [sent.id, id],
  );
  const photos = await sql<{ object_key: string }>(
    'SELECT object_key FROM submission_photos WHERE submission_id = $1',
    [sent.id],
  );
  for (const { object_key: key } of photos.rows) {
    const target = join(dir, ...key.replace(sent.id, id).split('/'));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(dir, ...key.split('/')), target);
  }
  await sql(
    `INSERT INTO submission_photos (submission_id, defect_id, object_key, sha256, size_bytes)
     SELECT $2::uuid, defect_id, replace(object_key, $1::uuid::text, $2::uuid::text), sha256, size_bytes
     FROM submission_photos WHERE submission_id = $1::uuid`,
    [sent.id, id],
  );
  return { ...sent, id, displayNo: `M100-${rows[0]!.display_no.padStart(6, '0')}` };
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
