import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DefectId, defaultMapping } from '@m100/shared';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createAdmin, pgAdminAccountRepositories } from '../admin/admin-accounts';
import type { AdminSubmissionDetail } from '../admin/submissions/submissions-admin.service';
import { configureApp } from '../app';
import { AppModule } from '../app.module';
import { TokenSigner } from '../auth/jwt';
import { TabletTokens } from '../auth/tablet-token';
import { Database } from '../db/database';
import { importMaster, pgImportRepositories } from '../import/import-master';
import { parseMaster } from '../import/parse-master';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { registerDevice } from '../testing/devices';
import { testConfig, testJwtKey } from '../testing/env';
import { fixtureTables } from '../testing/master-fixtures';
import { expectMatchesSpec, expectProblem } from '../testing/openapi';
import type { Correction } from './corrections.service';
import type { SubmissionResult } from './submission.service';

// The setup imports the master data and sends a submission and a correction over HTTP: slower than 30 s when the
// whole suite runs on a loaded machine.
jest.setTimeout(120_000);

let testDb: TestDatabase;
let photoDir: string;
let app: NestExpressApplication;
let cookie: string;

const PASSWORD = 'a-strong-password-1';
const XRW = { 'X-Requested-With': 'm100-admin' };
const mapping = defaultMapping();
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const jpeg = (seed: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(seed)]);

interface Tablet {
  key: string;
  token: string;
}

async function tablet(username: string, level: 'PSI lv.1' | 'PSI lv.2'): Promise<Tablet> {
  const device = await registerDevice(testDb.client);
  const { token } = new TabletTokens(new TokenSigner(testJwtKey())).issue({
    sub: username,
    lvl: level,
    fac: 'F 1',
    cel: 'F1-1',
    dev: device.id,
  });
  return { key: device.key, token };
}

const asTablet = (t: Tablet, r: request.Test) =>
  r.set('X-Device-Key', t.key).set('Authorization', `Bearer ${t.token}`);

function finding(defectId: DefectId, qty: number, second: number) {
  const entry = mapping.map.find((e) => e.defectId === defectId)!;
  return {
    inspectionType: 'REWORK' as const,
    areaId: entry.areaId,
    subAreaId: entry.subAreaId,
    defectId,
    qty,
    firstRecordedAt: `2026-10-16T13:00:0${second}.250+07:00`,
  };
}

const DEFECTS: DefectId[] = ['D035', 'D049', 'D082'];
const originalPhotos = new Map(DEFECTS.map((d) => [d, jpeg(`original ${d}`)]));
let budi: Tablet;
let andi: Tablet;
let id: string;
let json: string;
const replaced = jpeg('corrected D035');

/** The tablet's request of doc 04 §4.1. */
function submit(t: Tablet, body: string, photos: Map<DefectId, Buffer>) {
  let r = asTablet(t, request(app.getHttpServer()).post('/v1/submissions')).attach(
    'submission',
    Buffer.from(body),
    { filename: 'submission.json', contentType: 'application/json' },
  );
  for (const [d, bytes] of photos) {
    r = r.attach(`photo_${d}`, bytes, { filename: `${d}.jpg`, contentType: 'image/jpeg' });
  }
  return r;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: true });
  photoDir = mkdtempSync(join(tmpdir(), 'm100-corrections-'));
  const db = new Database(testDb.pool('m100_app'));
  await importMaster(db, pgImportRepositories(db), parseMaster(await fixtureTables()), {
    dryRun: false,
  });
  await createAdmin(db, pgAdminAccountRepositories(db), {
    username: 'qip.digital',
    password: PASSWORD,
    actor: 'script:admin:create',
  });
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
    .set('X-Forwarded-For', '10.5.0.1')
    .send({ username: 'qip.digital', password: PASSWORD });
  expect(login.status).toBe(204);
  cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!;

  budi = await tablet('TEST BUDI', 'PSI lv.2');
  andi = await tablet('TEST ANDI', 'PSI lv.1');
  id = randomUUID();
  json = JSON.stringify({
    submissionUuid: id,
    sealedAt: '2026-10-16T14:32:05.123+07:00',
    appVersion: '1.0.0',
    user: { username: 'TEST BUDI', level: 'PSI lv.2' },
    factory: 'F 1',
    cell: 'F1-1',
    po: 'CX-0902368685',
    partial: { number: 1, qty: 30 },
    counts: { rework: 10, bGrade: 0, noDefect: 18, reworkApproved: 3 },
    photoRule: 'ALL',
    findings: [finding('D035', 5, 1), finding('D049', 3, 2), finding('D082', 3, 3)],
    photos: DEFECTS.map((d) => ({
      defectId: d,
      part: `photo_${d}`,
      sha256: sha(originalPhotos.get(d)!),
    })),
  });
  expect((await submit(budi, json, originalPhotos)).status).toBe(201);

  // The admin corrects: NO DEFECT 18 → 17 and a new photo of D035.
  const detail = (
    await request(app.getHttpServer())
      .get(`/v1/admin/submissions/${id}`)
      .set('Cookie', cookie)
      .set('X-Forwarded-For', '10.5.0.2')
  ).body as AdminSubmissionDetail;
  const revision = {
    revisionId: randomUUID(),
    baseRevisionNo: 0,
    reason: 'NO DEFECT terhitung satu kali terlalu banyak',
    sealedAt: detail.sealedAt,
    username: detail.username,
    factory: detail.factory,
    cell: detail.cell,
    po: detail.po,
    partial: detail.partial,
    counts: { rework: 10, bGrade: 0, reworkApproved: 3, noDefect: 17 },
    findings: detail.findings.map((f) => ({
      inspectionType: f.inspectionType,
      areaId: f.areaId,
      subAreaId: f.subAreaId,
      defectId: f.defectId,
      qty: f.qty,
    })),
    photos: [
      { defectId: 'D035', part: 'photo_D035', sha256: sha(replaced) },
      { defectId: 'D049', keep: true },
      { defectId: 'D082', keep: true },
    ],
  };
  const corrected = await request(app.getHttpServer())
    .post(`/v1/admin/submissions/${id}/revisions`)
    .set('Cookie', cookie)
    .set(XRW)
    .set('X-Forwarded-For', '10.5.0.3')
    .field('revision', JSON.stringify(revision))
    .attach('photo_D035', replaced, { filename: 'D035.jpg', contentType: 'image/jpeg' });
  expect(corrected.status).toBe(201);
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
  if (photoDir) rmSync(photoDir, { recursive: true, force: true });
});

const corrections = (t: Tablet, ids: string) =>
  asTablet(t, request(app.getHttpServer()).get(`/v1/submissions/corrections?ids=${ids}`));

const bytesOf = (r: request.Test) =>
  r.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });

describe('GET /v1/submissions/corrections (ADR-023, doc 04 §3.4)', () => {
  it('gives the author the newest correction of their own submission and nothing else', async () => {
    const res = await corrections(budi, `${id},${randomUUID()}`);
    expect(res.status).toBe(200);
    expectMatchesSpec(res, 'get', '/submissions/corrections');
    const { items } = res.body as { items: Correction[] };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      submissionUuid: id,
      revisionNo: 1,
      reason: 'NO DEFECT terhitung satu kali terlalu banyak',
      submission: {
        user: { username: 'TEST BUDI', level: 'PSI lv.2' },
        countingRule: 'ADR-008',
        photoRule: 'ALL',
        counts: { rework: 10, bGrade: 0, reworkApproved: 3, noDefect: 17 },
        totals: { qtyInspection: 27, qtyAGrade: 17, qtyDefect: 11 },
      },
    });
    expect(items[0]!.photos.map((p) => [p.defectId, p.sha256])).toEqual([
      ['D035', sha(replaced)],
      ['D049', sha(originalPhotos.get('D049')!)],
      ['D082', sha(originalPhotos.get('D082')!)],
    ]);
  });

  it('leaves out another PSI’s submission', async () => {
    const res = await corrections(andi, id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('refuses no ids, more than 50 or a malformed one with 422', async () => {
    const many = Array.from({ length: 51 }, () => randomUUID()).join(',');
    for (const ids of ['', many, 'not-a-uuid']) {
      expectProblem(await corrections(budi, ids), 422, 'VALIDATION_FAILED');
    }
  });

  it('needs the device key and the tablet token; an admin cookie is not enough', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/submissions/corrections?ids=${id}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(401);
    // And a tablet is no admin.
    const admin = await asTablet(
      budi,
      request(app.getHttpServer()).get(`/v1/admin/submissions/${id}`),
    );
    expectProblem(admin, 401, 'ADMIN_AUTH_REQUIRED');
  });
});

describe('GET /v1/submissions/{id}/corrections/{n}/photos/{defectId}', () => {
  it('streams a photo of the newest correction to its author', async () => {
    const res = await bytesOf(
      asTablet(
        budi,
        request(app.getHttpServer()).get(`/v1/submissions/${id}/corrections/1/photos/D035`),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.body).toEqual(replaced);
    // A kept photo is the original's object.
    const kept = await bytesOf(
      asTablet(
        budi,
        request(app.getHttpServer()).get(`/v1/submissions/${id}/corrections/1/photos/D049`),
      ),
    );
    expect(kept.body).toEqual(originalPhotos.get('D049'));
  });

  it.each([
    ['another PSI', () => andi, `1/photos/D035`],
    ['revision 0', () => budi, `0/photos/D035`],
    ['a revision that does not exist', () => budi, `2/photos/D035`],
    ['a defect without a photo', () => budi, `1/photos/D001`],
  ])('answers 404 for %s', async (_name, who, rest) => {
    const res = await asTablet(
      who(),
      request(app.getHttpServer()).get(`/v1/submissions/${id}/corrections/${rest}`),
    );
    expectProblem(res, 404, 'NOT_FOUND');
  });
});

describe('the tablet resends the original after a correction (AC-17.7)', () => {
  it('is still answered 200 with the original result', async () => {
    const res = await submit(budi, json, originalPhotos);
    expect(res.status).toBe(200);
    expect((res.body as SubmissionResult).totals).toMatchObject({
      qtyInspection: 28,
      qtyAGrade: 18,
    });
  });
});
