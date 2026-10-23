import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../app';
import { AppModule } from '../../app.module';
import { Database } from '../../db/database';
import { DiskPhotoStore } from '../../photos/disk-photo-store';
import { createTestDatabase, type TestDatabase } from '../../testing/database';
import { registerDevice } from '../../testing/devices';
import { testConfig } from '../../testing/env';
import { expectMatchesSpec, expectProblem } from '../../testing/openapi';
import {
  FINDINGS,
  insertFinding,
  insertPhoto,
  insertSubmission,
  seedMasterData,
  submissionRow,
} from '../../testing/schema-fixtures';
import { createAdmin, pgAdminAccountRepositories } from '../admin-accounts';
import { CSV_BOM, EXPORT_COLUMNS } from './csv';
import type { AdminSubmissionDetail, AdminSubmissionPage } from './submissions-admin.service';

let testDb: TestDatabase;
let photoDir: string;
let app: NestExpressApplication;
let cookie: string;

const PASSWORD = 'a-strong-password-1';
const XRW = { 'X-Requested-With': 'm100-admin' };

/** The doc 02 §9 submission: findings with a Top 5 of D001, D002, D007, D004, D003; photos of D001 and D002. */
let full: string;
/** Same day, other cell and PSI, no partial, no findings. */
let plain: string;
/** Another factory and a PO with a prefix. */
let other: string;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2_000)]);

/** Each test sends from its own address, so no rate budget is shared between tests. */
let counter = 0;
let ip = '';
beforeEach(() => {
  ++counter;
  ip = `10.3.${Math.floor(counter / 250)}.${counter % 250}`;
});

const admin = () => {
  const agent = request(app.getHttpServer());
  const from = (r: request.Test) => r.set('X-Forwarded-For', ip).set('Cookie', cookie);
  return {
    get: (url: string) => from(agent.get(url)),
    raw: (method: 'post' | 'put' | 'patch' | 'delete', url: string) =>
      from(agent[method](url)).set(XRW).send({ username: 'X' }),
  };
};

/** The body as bytes, so the BOM and the JPEG arrive exactly as sent. */
function binary(res: request.Response, done: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
}

async function csv(query: string): Promise<{ res: request.Response; lines: string[] }> {
  const res = await admin()
    .get(`/v1/admin/submissions/export.csv${query}`)
    .buffer(true)
    .parse(binary);
  const text = (res.body as Buffer).toString('utf8');
  expect(text.startsWith(CSV_BOM)).toBe(true);
  expect(text.endsWith('\r\n')).toBe(true);
  return { res, lines: text.slice(CSV_BOM.length).split('\r\n').slice(0, -1) };
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: true });
  await testDb.as('m100_migrate', seedMasterData, { commit: true });
  const db = new Database(testDb.pool('m100_app'));
  await createAdmin(db, pgAdminAccountRepositories(db), {
    username: 'qip.digital',
    password: PASSWORD,
    actor: 'script:admin:create',
  });

  full = await insertSubmission(testDb.client, submissionRow());
  for (const f of FINDINGS) await insertFinding(testDb.client, full, f);
  photoDir = mkdtempSync(join(tmpdir(), 'm100-submissions-admin-'));
  const store = new DiskPhotoStore(photoDir);
  for (const d of ['D001', 'D002'] as const) {
    await insertPhoto(testDb.client, full, d);
    await store.put(
      `submissions/2026/10/${full}/${d}.jpg`,
      JPEG,
      createHash('sha256').update(JPEG).digest('hex'),
    );
  }
  plain = await insertSubmission(
    testDb.client,
    submissionRow({
      sealed_at: '2026-10-17T03:00:00.000Z',
      username: 'AZIZAH',
      level: 'PSI lv.1',
      cell: 'F3-11',
      partial_no: null,
      partial_qty: null,
      photo_count: 0,
    }),
  );
  other = await insertSubmission(
    testDb.client,
    submissionRow({
      sealed_at: '2026-10-18T03:00:00.000Z',
      inspection_date: '2026-10-18',
      factory: 'F 4',
      cell: 'F4-01',
      po: '=AB0903359388',
    }),
  );
  // 1,001 rows on 1 Aug: two pages of the list and two batches of the export.
  await testDb.client.query(
    `INSERT INTO submissions (id, payload_sha256, sealed_at, inspection_date, username, level, factory, cell, po,
                              article, model, destination, order_qty, qty_rework, qty_bgrade_inspections,
                              qty_no_defect, qty_inspection, qty_a_grade, qty_b_grade, qty_defect, rft, defect_rate,
                              photo_count)
     SELECT gen_random_uuid(), sha256(n::text::bytea), '2026-08-01T01:00:00Z'::timestamptz + n * interval '1 second',
            '2026-08-01', 'BULK', 'PSI lv.1', 'F 3', 'F3-10', 'BULK' || n, '', '', '', 100, 0, 0, 1, 1, 1, 0, 0,
            1, 0, 0
       FROM generate_series(1, 1001) AS n`,
  );

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forConfig(
        testConfig({
          databaseUrl: testDb.url('m100_app'),
          photoStore: { kind: 'disk', dir: photoDir },
        }),
      ),
    ],
  }).compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }));
  await app.init();
  const login = await request(app.getHttpServer())
    .post('/v1/admin/auth/login')
    .set(XRW)
    .set('X-Forwarded-For', '10.3.255.1')
    .send({ username: 'qip.digital', password: PASSWORD });
  expect(login.status).toBe(204);
  cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!;
});
afterAll(async () => {
  await app?.close();
  await testDb?.drop();
  if (photoDir) rmSync(photoDir, { recursive: true, force: true });
});

describe('GET /v1/admin/submissions (doc 05 §20.3, A12)', () => {
  it('lists the filtered submissions newest first with the table values', async () => {
    const res = await admin().get('/v1/admin/submissions?from=2026-10-17&to=2026-10-18');
    expect(res.status).toBe(200);
    expectMatchesSpec(res, 'get', '/admin/submissions');
    const page = res.body as AdminSubmissionPage;
    expect(page).toMatchObject({ total: 3, page: 1, pageSize: 50 });
    expect(page.items.map((s) => s.id)).toEqual([other, plain, full]);
    expect(page.items[2]).toMatchObject({
      displayNo: expect.stringMatching(/^M100-\d{6}$/) as string,
      sealedAt: '2026-10-17T00:30:00.000+07:00',
      inspectionDate: '2026-10-17',
      partialText: 'P1 1.200 OF 10.002',
      qtyInspection: 30,
      qtyDefect: 11,
      qtyAGrade: 18,
      qtyBGrade: 3,
      rft: 0.6,
      defectRate: 0.36667,
    });
  });

  it('applies each filter; an empty value is no filter', async () => {
    const ids = async (query: string) =>
      ((await admin().get(`/v1/admin/submissions?${query}`)).body as AdminSubmissionPage).items.map(
        (s) => s.id,
      );
    expect(await ids('to=2026-10-17&from=2026-10-17')).toEqual([plain, full]);
    expect(await ids('from=2026-10-17&factory=F%204')).toEqual([other]);
    expect(await ids('from=2026-10-17&cell=F3-11')).toEqual([plain]);
    expect(await ids('from=2026-10-17&username=AZIZAH')).toEqual([plain]);
    expect(await ids('from=2026-10-17&po=ab09')).toEqual([other]);
    expect(await ids('from=2026-10-17&po=&factory=&cell=F3-11')).toEqual([plain]);
  });

  it('pages by 50 and counts every match', async () => {
    const first = (await admin().get('/v1/admin/submissions?from=2026-08-01&to=2026-08-01'))
      .body as AdminSubmissionPage;
    expect(first.total).toBe(1001);
    expect(first.items).toHaveLength(50);
    expect(first.items[0]!.po).toBe('BULK1001');
    const last = (await admin().get('/v1/admin/submissions?from=2026-08-01&to=2026-08-01&page=21'))
      .body as AdminSubmissionPage;
    expect(last).toMatchObject({ total: 1001, page: 21 });
    expect(last.items.map((s) => s.po)).toEqual(['BULK1']);
  });

  it.each([
    ['from=2026-02-30', 'from'],
    ['from=17-10-2026', 'from'],
    ['from=2026-10-18&to=2026-10-17', 'to'],
    ['page=0', 'page'],
    ['page=x', 'page'],
    ['cell=a&cell=b', 'cell'],
  ])('refuses %s with 422', async (query, path) => {
    const res = await admin().get(`/v1/admin/submissions?${query}`);
    const body = expectProblem(res, 422, 'VALIDATION_FAILED');
    expect(body.errors!.map((e) => e.path)).toContain(path);
  });
});

describe('GET /v1/admin/submissions/{id} (doc 05 §20.3, A1b)', () => {
  it('returns the submission with its findings in tap order, the Top 5 and the photo ids', async () => {
    const res = await admin().get(`/v1/admin/submissions/${full}`);
    expect(res.status).toBe(200);
    expectMatchesSpec(res, 'get', '/admin/submissions/{id}');
    const detail = res.body as AdminSubmissionDetail;
    expect(detail).toMatchObject({
      id: full,
      article: 'IH1234',
      orderQty: 10002,
      podd: '2026-01-12',
      crd: null,
      partial: { number: 1, qty: 1200 },
      counts: { rework: 10, bGrade: 2, noDefect: 18 },
      appVersion: '1.0.0',
      audit: [],
    });
    const tapOrder = [...FINDINGS].sort(
      (a, b) => Date.parse(a.firstRecordedAt) - Date.parse(b.firstRecordedAt),
    );
    expect(detail.findings.map((f) => f.defectId)).toEqual(tapOrder.map((f) => f.defectId));
    expect(detail.findings[0]).toMatchObject({
      areaName: 'TOE',
      subAreaName: 'TOE TIP',
      familyName: 'BONDING',
    });
    expect(detail.top5.map((t) => [t.rank, t.defectId, t.qty])).toEqual([
      [1, 'D001', 3],
      [2, 'D002', 2],
      [3, 'D007', 2],
      [4, 'D004', 1],
      [5, 'D003', 1],
    ]);
    const photoIds = Object.fromEntries(detail.photos.map((p) => [p.defectId, p.id]));
    expect(detail.top5.map((t) => t.photoId)).toEqual([
      photoIds.D001,
      photoIds.D002,
      null,
      null,
      null,
    ]);
  });

  it('answers 404 for an unknown or malformed id', async () => {
    expectProblem(
      await admin().get('/v1/admin/submissions/00000000-0000-4000-8000-000000000000'),
      404,
      'NOT_FOUND',
    );
    expectProblem(await admin().get('/v1/admin/submissions/not-a-uuid'), 404, 'NOT_FOUND');
  });
});

describe('GET /v1/admin/photos/{id} (doc 02 §7)', () => {
  const photoId = async (defectId: string) =>
    (
      (await admin().get(`/v1/admin/submissions/${full}`)).body as AdminSubmissionDetail
    ).photos.find((p) => p.defectId === defectId)!.id;

  it('streams the JPEG exactly as stored to an admin', async () => {
    const res = await admin()
      .get(`/v1/admin/photos/${await photoId('D001')}`)
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect((res.body as Buffer).equals(JPEG)).toBe(true);
  });

  it('refuses everyone without an admin session, a tablet included', async () => {
    const id = await photoId('D001');
    const tablet = await registerDevice(testDb.client);
    const anonymous = await request(app.getHttpServer())
      .get(`/v1/admin/photos/${id}`)
      .set('X-Forwarded-For', ip);
    expectProblem(anonymous, 401, 'ADMIN_AUTH_REQUIRED');
    const fromTablet = await request(app.getHttpServer())
      .get(`/v1/admin/photos/${id}`)
      .set('X-Forwarded-For', ip)
      .set('X-Device-Key', tablet.key);
    expectProblem(fromTablet, 401, 'ADMIN_AUTH_REQUIRED');
    const forged = await request(app.getHttpServer())
      .get(`/v1/admin/photos/${id}`)
      .set('X-Forwarded-For', ip)
      .set('Cookie', `${cookie.split('=')[0]}=forged`);
    expectProblem(forged, 401, 'ADMIN_AUTH_REQUIRED');
  });

  it('answers 404 for an unknown id', async () => {
    expectProblem(await admin().get('/v1/admin/photos/999999'), 404, 'NOT_FOUND');
    expectProblem(await admin().get('/v1/admin/photos/abc'), 404, 'NOT_FOUND');
  });

  it('answers 503 PHOTO_STORE_UNAVAILABLE when the store cannot be read', async () => {
    // A photo row whose key names a folder: reading it fails with an error other than "not found".
    await insertPhoto(testDb.client, other, 'D003');
    mkdirSync(join(photoDir, 'submissions', '2026', '10', other, 'D003.jpg'), { recursive: true });
    const id = await (async () =>
      ((await admin().get(`/v1/admin/submissions/${other}`)).body as AdminSubmissionDetail)
        .photos[0]!.id)();
    expectProblem(await admin().get(`/v1/admin/photos/${id}`), 503, 'PHOTO_STORE_UNAVAILABLE');
  });

  it('answers 404 when the row has no object', async () => {
    await insertPhoto(testDb.client, plain, 'D005');
    const id = ((await admin().get(`/v1/admin/submissions/${plain}`)).body as AdminSubmissionDetail)
      .photos[0]!.id;
    expectProblem(await admin().get(`/v1/admin/photos/${id}`), 404, 'NOT_FOUND');
  });
});

describe('GET /v1/admin/submissions/export.csv (A14)', () => {
  it('exports the filter as UTF-8 CSV with a BOM, a header and one CRLF row per submission', async () => {
    const { res, lines } = await csv('?from=2026-10-17&to=2026-10-18');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="m100-submissions-2026-10-17-2026-10-18.csv"',
    );
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(lines[0]).toBe(EXPORT_COLUMNS.join(','));
    const rows = lines.slice(1).map((l) => l.split(','));
    const column = (name: string) => EXPORT_COLUMNS.indexOf(name);
    // The list's order and rows.
    expect(rows.map((r) => r[column('id')])).toEqual([other, plain, full]);
    const fullRow = rows[2]!;
    expect(fullRow[column('rft')]).toBe('0.60000');
    expect(fullRow[column('defect_rate')]).toBe('0.36667');
    expect(fullRow[column('order_qty')]).toBe('10002');
    expect(fullRow[column('sealed_at')]).toBe('2026-10-17T00:30:00.000+07:00');
    expect(fullRow[column('partial_text')]).toBe('P1 1.200 OF 10.002');
    expect([1, 2, 3, 4, 5].map((n) => fullRow[column(`top${n}_defect_id`)])).toEqual([
      'D001',
      'D002',
      'D007',
      'D004',
      'D003',
    ]);
    expect(fullRow[column('top1_qty')]).toBe('3');
    expect(rows[1]![column('top1_defect_id')]).toBe('');
    // A PO that a spreadsheet would run as a formula is defused.
    expect(rows[0]![column('po')]).toBe("'=AB0903359388");
  });

  it('matches the list for the same filter, across export batches', async () => {
    const { lines } = await csv('?from=2026-08-01&to=2026-08-01');
    expect(lines).toHaveLength(1 + 1001);
    const pos = lines.slice(1).map((l) => l.split(',')[EXPORT_COLUMNS.indexOf('po')]);
    expect(new Set(pos).size).toBe(1001);
    expect(pos[0]).toBe('BULK1001');
    expect(pos.at(-1)).toBe('BULK1');
  });

  it('writes only the header for an empty result, and names an open range "all"', async () => {
    const { res, lines } = await csv('?from=2030-01-01');
    expect(lines).toEqual([EXPORT_COLUMNS.join(',')]);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="m100-submissions-2030-01-01-all.csv"',
    );
  });

  it('refuses a bad filter with 422 and a tablet with 401', async () => {
    expectProblem(
      await admin().get('/v1/admin/submissions/export.csv?to=x'),
      422,
      'VALIDATION_FAILED',
    );
    const tablet = await registerDevice(testDb.client);
    const res = await request(app.getHttpServer())
      .get('/v1/admin/submissions/export.csv')
      .set('X-Forwarded-For', ip)
      .set('X-Device-Key', tablet.key);
    expectProblem(res, 401, 'ADMIN_AUTH_REQUIRED');
  });
});

describe('Submissions are read-only (AC-14.4, BR-07)', () => {
  const snapshot = async () =>
    (
      await testDb.client.query(
        `SELECT (SELECT count(*) FROM submissions)::integer AS submissions,
                (SELECT count(*) FROM submission_findings)::integer AS findings,
                (SELECT count(*) FROM submission_photos)::integer AS photos,
                (SELECT username FROM submissions WHERE id = $1) AS username`,
        [full],
      )
    ).rows[0] as unknown;

  it('has no route that adds, changes or removes a submission', async () => {
    const before = await snapshot();
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      for (const url of [
        '/v1/admin/submissions',
        `/v1/admin/submissions/${full}`,
        '/v1/admin/photos/1',
      ]) {
        const res = await admin().raw(method, url);
        expect([404, 405]).toContain(res.status);
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it('is refused by the database for the API role, also by hand', async () => {
    await expect(
      testDb.as('m100_app', (c) =>
        c.query(`UPDATE submissions SET username = 'X' WHERE id = $1`, [full]),
      ),
    ).rejects.toThrow();
    await expect(
      testDb.as('m100_app', (c) => c.query(`DELETE FROM submissions WHERE id = $1`, [full])),
    ).rejects.toThrow();
    await expect(
      testDb.client.query(`UPDATE submission_findings SET qty = 99 WHERE submission_id = $1`, [
        full,
      ]),
    ).rejects.toThrow();
  });
});
