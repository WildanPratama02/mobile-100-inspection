import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { testConfig } from '../../testing/env';
import { expectMatchesSpec, expectProblem } from '../../testing/openapi';
import {
  FINDINGS,
  insertFinding,
  insertSubmission,
  seedMasterData,
  submissionRow,
} from '../../testing/schema-fixtures';
import { createAdmin, pgAdminAccountRepositories } from '../admin-accounts';
import { CSV_BOM, EXPORT_COLUMNS } from './csv';
import type { AdminRevisionHistory } from './revisions-admin.service';
import type { AdminSubmissionDetail, AdminSubmissionPage } from './submissions-admin.service';

let testDb: TestDatabase;
let photoDir: string;
let store: DiskPhotoStore;
let app: NestExpressApplication;
let cookie: string;

const PASSWORD = 'a-strong-password-1';
const XRW = { 'X-Requested-With': 'm100-admin' };
const REASON = 'Salah input oleh PSI, dikoreksi admin';
const jpeg = (seed: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(seed), randomBytes(500)]);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let counter = 0;
let ip = '';
beforeEach(() => {
  ++counter;
  ip = `10.4.${Math.floor(counter / 250)}.${counter % 250}`;
});

const http = () => request(app.getHttpServer());
const get = (url: string) => http().get(url).set('X-Forwarded-For', ip).set('Cookie', cookie);

/** `POST …/revisions` with the JSON part and new photo parts. */
function post(
  id: string,
  body: unknown,
  photos: Record<string, Buffer> = {},
  options: { xrw?: boolean } = {},
) {
  let r = http()
    .post(`/v1/admin/submissions/${id}/revisions`)
    .set('X-Forwarded-For', ip)
    .set('Cookie', cookie);
  if (options.xrw !== false) r = r.set(XRW);
  r = r.field('revision', JSON.stringify(body));
  for (const [part, bytes] of Object.entries(photos)) {
    r = r.attach(part, bytes, { filename: `${part}.jpg`, contentType: 'image/jpeg' });
  }
  return r;
}

const detail = async (id: string, query = '') =>
  (await get(`/v1/admin/submissions/${id}${query}`)).body as AdminSubmissionDetail;

/** The correction form's first state: the effective version, every photo kept. */
async function form(id: string) {
  const d = await detail(id);
  return {
    revisionId: randomUUID(),
    baseRevisionNo: d.latestRevisionNo,
    reason: REASON,
    sealedAt: d.sealedAt,
    username: d.username,
    factory: d.factory,
    cell: d.cell,
    po: d.po,
    partial: d.partial,
    counts: {
      rework: d.counts.rework,
      bGrade: d.counts.bGrade,
      reworkApproved: d.counts.reworkApproved ?? 0,
      ...(d.countingRule === 'ADR-008'
        ? { noDefect: d.counts.noDefect! }
        : { qtyInspection: d.counts.qtyInspection }),
    } as Record<string, number>,
    findings: d.findings.map((f) => ({
      inspectionType: f.inspectionType,
      areaId: f.areaId,
      subAreaId: f.subAreaId,
      defectId: f.defectId,
      qty: f.qty,
    })),
    photos: d.photos.map((p) => ({ defectId: p.defectId, keep: true })) as Record<
      string,
      unknown
    >[],
  };
}

const latest = async (id: string) =>
  (
    await testDb.client.query<{ n: number }>(
      'SELECT coalesce(max(revision_no), 0)::int AS n FROM submission_revisions WHERE submission_id = $1',
      [id],
    )
  ).rows[0]!.n;

/** PSI lv.1, entered counts: Qty Inspection 30, D001 REWORK 2 and B-GRADE 1 (Qty Defect 3). */
let lv1: string;
/** PSI lv.2 with photo rule ALL: NO DEFECT 18, D001 ×3 and D002 ×2, a photo of each. */
let lv2: string;
const lv2Photos: Record<string, Buffer> = { D001: jpeg('D001'), D002: jpeg('D002') };

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: true });
  await testDb.as(
    'm100_migrate',
    async (c) => {
      await seedMasterData(c);
      await c.query(`
        INSERT INTO psi_users (username, level) VALUES
          ('AZIZAH', 'PSI lv.1'), ('SITI', 'PSI lv.1'), ('ROIS FATHUR ROHIM', 'PSI lv.2'), ('BUDI', 'PSI lv.2');
        INSERT INTO factories (name) VALUES ('F 3');
        INSERT INTO cells (factory_id, code) SELECT id, c FROM factories, unnest(ARRAY['F3-10', 'F3-11']) c;
        INSERT INTO pos (po, article, model, destination, order_qty, podd, crd, source)
          VALUES ('0903359999', 'ART-9', 'MODEL 9', 'USA', 50, NULL, '2027-01-05', 'admin');`);
    },
    { commit: true },
  );
  const db = new Database(testDb.pool('m100_app'));
  await createAdmin(db, pgAdminAccountRepositories(db), {
    username: 'qip.digital',
    password: PASSWORD,
    actor: 'script:admin:create',
  });

  lv1 = await insertSubmission(
    testDb.client,
    submissionRow({
      username: 'AZIZAH',
      level: 'PSI lv.1',
      counting_rule: 'ADR-019',
      partial_no: null,
      partial_qty: null,
      qty_no_defect: null,
      qty_inspection: 30,
      qty_a_grade: 27,
      qty_b_grade: 1,
      qty_defect: 3,
      rft: '0.90000',
      defect_rate: '0.10000',
      photo_count: 0,
      qty_rework_approved: 4,
    }),
  );
  for (const f of [FINDINGS[0]!, FINDINGS[6]!]) await insertFinding(testDb.client, lv1, f);

  photoDir = mkdtempSync(join(tmpdir(), 'm100-revisions-admin-'));
  store = new DiskPhotoStore(photoDir);
  lv2 = await insertSubmission(
    testDb.client,
    submissionRow({
      photo_rule: 'ALL',
      qty_b_grade: 1,
      qty_defect: 5,
      defect_rate: '0.16667',
      photo_count: 2,
      qty_rework_approved: 2,
    }),
  );
  for (const f of [FINDINGS[0]!, FINDINGS[1]!, FINDINGS[6]!])
    await insertFinding(testDb.client, lv2, f);
  for (const [d, bytes] of Object.entries(lv2Photos)) {
    const key = `submissions/2026/10/${lv2}/${d}.jpg`;
    await testDb.client.query(
      `INSERT INTO submission_photos (submission_id, defect_id, object_key, sha256, size_bytes)
       VALUES ($1, $2, $3, $4, $5)`,
      [lv2, d, key, Buffer.from(sha(bytes), 'hex'), bytes.length],
    );
    await store.put(key, bytes, sha(bytes));
  }

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
  const login = await http()
    .post('/v1/admin/auth/login')
    .set(XRW)
    .set('X-Forwarded-For', '10.4.255.1')
    .send({ username: 'qip.digital', password: PASSWORD });
  expect(login.status).toBe(204);
  cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!;
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
  if (photoDir) rmSync(photoDir, { recursive: true, force: true });
});

describe('POST /v1/admin/submissions/{id}/revisions (ADR-023, doc 04 §8.1)', () => {
  it('writes a correction as revision 1; the original rows stay byte for byte', async () => {
    const before = await testDb.client.query('SELECT * FROM submissions WHERE id = $1', [lv1]);
    const findingsBefore = await testDb.client.query(
      'SELECT * FROM submission_findings WHERE submission_id = $1 ORDER BY id',
      [lv1],
    );
    const body = await form(lv1);
    body.counts.qtyInspection = 25;
    const res = await post(lv1, body);
    expect(res.status).toBe(201);
    expectMatchesSpec(res, 'post', '/admin/submissions/{id}/revisions');
    const d = res.body as AdminSubmissionDetail;
    expect(d).toMatchObject({
      revisionNo: 1,
      latestRevisionNo: 1,
      qtyInspection: 25,
      qtyDefect: 3,
      qtyAGrade: 22,
      rft: 0.88,
      correctedBy: 'qip.digital',
      correctionReason: REASON,
      counts: { qtyInspection: 25, reworkApproved: 4, noDefect: null },
    });
    expect(
      (await testDb.client.query('SELECT * FROM submissions WHERE id = $1', [lv1])).rows,
    ).toEqual(before.rows);
    expect(
      (
        await testDb.client.query(
          'SELECT * FROM submission_findings WHERE submission_id = $1 ORDER BY id',
          [lv1],
        )
      ).rows,
    ).toEqual(findingsBefore.rows);

    // The reporting views, the list, the original version and the history.
    const view = await testDb.client.query(
      'SELECT qty_inspection, qty_a_grade, revision_no, corrected_by FROM v_submissions WHERE id = $1',
      [lv1],
    );
    expect(view.rows[0]).toEqual({
      qty_inspection: 25,
      qty_a_grade: 22,
      revision_no: 1,
      corrected_by: 'qip.digital',
    });
    const original = await get(`/v1/admin/submissions/${lv1}?revision=0`);
    expectMatchesSpec(original, 'get', '/admin/submissions/{id}');
    expect(original.body).toMatchObject({ revisionNo: 0, latestRevisionNo: 1, qtyInspection: 30 });
    expect((await get(`/v1/admin/submissions/${lv1}?revision=2`)).status).toBe(404);

    const history = await get(`/v1/admin/submissions/${lv1}/revisions`);
    expectMatchesSpec(history, 'get', '/admin/submissions/{id}/revisions');
    expect((history.body as AdminRevisionHistory).items).toMatchObject([
      { revisionNo: 0, by: 'AZIZAH', reason: null },
      {
        revisionNo: 1,
        by: 'qip.digital',
        reason: REASON,
        changes: { fields: [{ field: 'counts.qtyInspection', old: 30, new: 25 }] },
      },
    ]);
    expect(d.audit).toEqual([
      expect.objectContaining({
        actor: 'admin:qip.digital',
        action: 'submission.revise',
        details: expect.objectContaining({ revisionNo: 1, reason: REASON }) as unknown,
      }),
    ]);

    const list = await get('/v1/admin/submissions?from=2026-10-17&to=2026-10-17');
    expect((list.body as AdminSubmissionPage).items.find((s) => s.id === lv1)).toMatchObject({
      revisionNo: 1,
      qtyInspection: 25,
    });
    const csv = (
      await get('/v1/admin/submissions/export.csv?from=2026-10-17&to=2026-10-17').buffer(true)
    ).text;
    const lines = csv.slice(CSV_BOM.length).split('\r\n');
    const row = lines.find((l) => l.includes(lv1))!.split(',');
    expect(row[EXPORT_COLUMNS.indexOf('qty_inspection')]).toBe('25');
    expect(row[EXPORT_COLUMNS.indexOf('revision_no')]).toBe('1');
    expect(row[EXPORT_COLUMNS.indexOf('corrected_by')]).toBe('qip.digital');
  });

  it.each([
    [
      'a reason under 10 characters',
      (b: Awaited<ReturnType<typeof form>>) => (b.reason = 'kurang'),
      'reason',
    ],
    ['a level change', (b: Awaited<ReturnType<typeof form>>) => (b.username = 'BUDI'), 'username'],
    [
      'Qty Inspection below Qty Defect (BR-10)',
      (b: Awaited<ReturnType<typeof form>>) => (b.counts.qtyInspection = 2),
      'counts.qtyInspection',
    ],
    [
      'Rework and Approved above rework (BR-11)',
      (b: Awaited<ReturnType<typeof form>>) => (b.counts.reworkApproved = 11),
      'counts.reworkApproved',
    ],
    [
      'a duplicate finding',
      (b: Awaited<ReturnType<typeof form>>) => b.findings.push({ ...b.findings[0]! }),
      'findings[2]',
    ],
    [
      'the other counting rule',
      (b: Awaited<ReturnType<typeof form>>) => {
        delete b.counts.qtyInspection;
        b.counts.noDefect = 20;
      },
      'counts',
    ],
    ['no change at all', () => undefined, ''],
    ['an unknown cell', (b: Awaited<ReturnType<typeof form>>) => (b.cell = 'F9-99'), 'cell'],
  ])('refuses %s with 422 and writes nothing', async (_name, change, path) => {
    const n = await latest(lv1);
    const body = await form(lv1);
    change(body);
    const res = await post(lv1, body);
    expect(res.status).toBe(422);
    expect((res.body as { errors: { path: string }[] }).errors.map((e) => e.path)).toContain(path);
    expect(await latest(lv1)).toBe(n);
  });

  it('refuses a photo from PSI lv.1', async () => {
    const body = await form(lv1);
    body.counts.qtyInspection = 26;
    const photo = jpeg('x');
    body.photos = [{ defectId: 'D001', part: 'photo_D001', sha256: sha(photo) }];
    expectProblem(await post(lv1, body, { photo_D001: photo }), 422, 'PHOTO_NOT_ALLOWED');
  });

  it('refuses a stale base with 409 REVISION_CONFLICT; of two saves at once one wins', async () => {
    const stale = await form(lv1);
    stale.baseRevisionNo = 0;
    stale.counts.qtyInspection = 27;
    expectProblem(await post(lv1, stale), 409, 'REVISION_CONFLICT');

    const a = await form(lv1);
    const b = await form(lv1);
    a.counts.qtyInspection = 28;
    b.counts.qtyInspection = 29;
    const results = await Promise.all([post(lv1, a), post(lv1, b)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('answers a repeat of the same revision id and bytes with 200, other bytes with 409 CONFLICT', async () => {
    const body = await form(lv1);
    body.counts.qtyInspection = 24;
    expect((await post(lv1, body)).status).toBe(201);
    const n = await latest(lv1);
    const again = await post(lv1, body);
    expect(again.status).toBe(200);
    expect((again.body as AdminSubmissionDetail).revisionNo).toBe(n);
    expectProblem(await post(lv1, { ...body, reason: `${REASON}!` }), 409, 'CONFLICT');
    expect(await latest(lv1)).toBe(n);
  });

  it('needs the admin session and X-Requested-With', async () => {
    const body = await form(lv1);
    expectProblem(await post(lv1, body, {}, { xrw: false }), 401, 'ADMIN_AUTH_REQUIRED');
    const anonymous = await http()
      .post(`/v1/admin/submissions/${lv1}/revisions`)
      .set(XRW)
      .set('X-Forwarded-For', ip)
      .field('revision', JSON.stringify(body));
    expectProblem(anonymous, 401, 'ADMIN_AUTH_REQUIRED');
    expectProblem(await post(randomUUID(), body), 404, 'NOT_FOUND');
  });
});

describe('PO snapshot and photos of a correction (PSI lv.2, photo rule ALL)', () => {
  it('keeps the snapshot of an unchanged PO although the master changed, and takes a new PO from the master', async () => {
    await testDb.client.query(`UPDATE pos SET article = 'EDITED' WHERE po = '0902028839'`);
    const body = await form(lv2);
    body.cell = 'F3-11';
    const same = await post(lv2, body);
    expect(same.status).toBe(201);
    expect(same.body).toMatchObject({ cell: 'F3-11', article: 'IH1234', orderQty: 10002 });

    const moved = await form(lv2);
    moved.po = '0903359999';
    moved.partial = null;
    const res = await post(lv2, moved);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      po: '0903359999',
      article: 'ART-9',
      model: 'MODEL 9',
      destination: 'USA',
      orderQty: 50,
      podd: null,
      crd: '2027-01-05',
    });
  });

  it('refuses a new defect without a photo, then keeps, replaces and adds photos under r<n>/', async () => {
    const body = await form(lv2);
    body.findings.push({
      inspectionType: 'REWORK',
      areaId: 'A02',
      subAreaId: 'SA02',
      defectId: 'D003',
      qty: 1,
    });
    body.counts.noDefect = 17; // the PO now has 50 pairs at most
    expectProblem(await post(lv2, body), 422, 'PHOTO_MISSING');

    const replaced = jpeg('D002 new');
    const added = jpeg('D003');
    body.photos = [
      { defectId: 'D001', keep: true },
      { defectId: 'D002', part: 'photo_D002', sha256: sha(replaced) },
      { defectId: 'D003', part: 'photo_D003', sha256: sha(added) },
    ];
    const res = await post(lv2, body, { photo_D002: replaced, photo_D003: added });
    expect(res.status).toBe(201);
    const d = res.body as AdminSubmissionDetail;
    const n = d.revisionNo;
    const keys = await testDb.client.query<{ defect_id: string; object_key: string }>(
      `SELECT defect_id, object_key FROM v_effective_photos WHERE submission_id = $1 ORDER BY defect_id`,
      [lv2],
    );
    expect(keys.rows).toEqual([
      { defect_id: 'D001', object_key: `submissions/2026/10/${lv2}/D001.jpg` },
      { defect_id: 'D002', object_key: `submissions/2026/10/${lv2}/r${n}/D002.jpg` },
      { defect_id: 'D003', object_key: `submissions/2026/10/${lv2}/r${n}/D003.jpg` },
    ]);
    const photo = d.photos.find((p) => p.defectId === 'D002')!;
    expect(photo.url).toBe(`/v1/admin/revision-photos/${photo.id}`);
    const bytes = await get(photo.url.replace(/^\/v1/, '/v1'))
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(bytes.status).toBe(200);
    expect(bytes.body).toEqual(replaced);
    // The original's photo is still there for revision 0.
    const original = await detail(lv2, '?revision=0');
    expect(original.photos.map((p) => p.url)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\/v1\/admin\/photos\/\d+$/)]),
    );
  });
});
