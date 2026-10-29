import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import {
  defaultMapping,
  type DefectId,
  type Finding,
  type InspectionType,
  photoKey,
  type SubmissionRequest,
} from '@m100/shared';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request, { type Response } from 'supertest';
import { configureApp } from '../app';
import { AppModule } from '../app.module';
import { TokenSigner } from '../auth/jwt';
import { type TabletClaims, TabletTokens } from '../auth/tablet-token';
import { createPool, Database, type Queryable, type TransactionOptions } from '../db/database';
import { importMaster, pgImportRepositories } from '../import/import-master';
import { parseMaster } from '../import/parse-master';
import { ReadinessService } from '../master-data/readiness.service';
import { DiskPhotoStore } from '../photos/disk-photo-store';
import { PHOTO_STORE, type PhotoStore } from '../photos/photo-store';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { registerDevice, type TestDevice } from '../testing/devices';
import { testConfig, testJwtKey } from '../testing/env';
import { fixtureTables } from '../testing/master-fixtures';
import { expectMatchesSpec, expectProblem } from '../testing/openapi';
import { sha256Hex } from './multipart';
import type { SubmissionResult } from './submission.service';

const mapping = defaultMapping();

/** Wraps the folder store; while `failAfter` is set, every put after that many succeeded ones throws. */
class FailingStore implements PhotoStore {
  failAfter: number | null = null;
  private puts = 0;

  constructor(private readonly inner: PhotoStore) {}

  put(key: string, jpeg: Buffer, sha256: string): Promise<void> {
    if (this.failAfter !== null && this.puts >= this.failAfter) {
      return Promise.reject(new Error('Photo store full'));
    }
    this.puts++;
    return this.inner.put(key, jpeg, sha256);
  }
  get(key: string) {
    return this.inner.get(key);
  }
  exists(key: string) {
    return this.inner.exists(key);
  }
  delete(key: string) {
    return this.inner.delete(key);
  }
  probe() {
    return this.inner.probe();
  }
  list() {
    return this.inner.list();
  }
  arm(failAfter: number | null): void {
    this.failAfter = failAfter;
    this.puts = 0;
  }
}

/** A `Database` whose next read-write transaction fails with `failure` after its work, just before COMMIT. */
class FaultyDatabase extends Database {
  failure: Error | undefined;

  override transaction<T>(
    fn: (tx: Queryable) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    return super.transaction(async (tx) => {
      const result = await fn(tx);
      if (this.failure !== undefined && !options.readOnly) {
        const failure = this.failure;
        this.failure = undefined;
        throw failure;
      }
      return result;
    }, options);
  }
}

interface TestApp {
  app: NestExpressApplication;
  readiness: ReadinessService;
  /** The app's own pool; closing the app ends it. */
  database: FaultyDatabase;
}

let testDb: TestDatabase;
let photoDir: string;
let store: FailingStore;
let main: TestApp;
const apps: NestExpressApplication[] = [];
const logLines: Record<string, unknown>[] = [];

async function startApp(): Promise<TestApp> {
  const logDestination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        logLines.push(JSON.parse(line) as Record<string, unknown>);
      }
      done();
    },
  });
  const config = testConfig({
    databaseUrl: testDb.url('m100_app'),
    photoStore: { kind: 'disk', dir: photoDir },
    logLevel: 'info',
  });
  const database = new FaultyDatabase(createPool(config.databaseUrl, 'm100 test api'));
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forConfig(config, { logDestination })],
  })
    .overrideProvider(PHOTO_STORE)
    .useValue(store)
    .overrideProvider(Database)
    .useValue(database)
    .compile();
  const app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
  await app.init();
  apps.push(app);
  const readiness = app.get(ReadinessService);
  expect((await readiness.check()).submitEnabled).toBe(true);
  return { app, readiness, database };
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: true });
  photoDir = mkdtempSync(join(tmpdir(), 'm100-submissions-'));
  store = new FailingStore(new DiskPhotoStore(photoDir));
  const db = new Database(testDb.pool('m100_app'));
  await importMaster(db, pgImportRepositories(db), parseMaster(await fixtureTables()), {
    dryRun: false,
  });
  main = await startApp();
});

afterAll(async () => {
  await testDb?.allowConnections(true).catch(() => undefined);
  for (const app of apps) await app.close();
  await testDb?.drop();
  rmSync(photoDir, { recursive: true, force: true });
});

interface Tablet {
  device: TestDevice;
  token: string;
}

const BUDI = { username: 'TEST BUDI', level: 'PSI lv.2' } as const;
const ANDI = { username: 'TEST ANDI', level: 'PSI lv.1' } as const;

/** A tablet of its own per test, so the rate limit of one device (60 a minute) never interferes. */
async function tablet(
  user: { username: string; level: TabletClaims['lvl'] } = BUDI,
): Promise<Tablet> {
  const device = await registerDevice(testDb.client);
  const { token } = new TabletTokens(new TokenSigner(testJwtKey())).issue({
    sub: user.username,
    lvl: user.level,
    fac: 'F 1',
    cel: 'F1-1',
    dev: device.id,
  });
  return { device, token };
}

/** A finding on the defect's first map row. */
function finding(
  defectId: DefectId,
  qty: number,
  inspectionType: InspectionType = 'REWORK',
  second = 1,
): Omit<Finding, 'familyId'> {
  const entry = mapping.map.find((e) => e.defectId === defectId);
  if (!entry) throw new Error(`No map entry for ${defectId}`);
  return {
    inspectionType,
    areaId: entry.areaId,
    subAreaId: entry.subAreaId,
    defectId,
    qty,
    firstRecordedAt: `2026-10-16T13:00:${String(second).padStart(2, '0')}.250+07:00`,
  };
}

type Body = Omit<SubmissionRequest, 'findings' | 'photos'> & {
  findings: Omit<Finding, 'familyId'>[];
};

const SEALED_AT = '2026-10-16T14:32:05.123+07:00';

/**
 * The doc 02 §9 example from PSI lv.2: 30 inspections, 11 defects, 3 of them on B-GRADE pairs. On a PO of 1.200
 * with a partial of 30, so the 30 tapped pairs are within the maximum (ADR-021).
 */
function body(overrides: Partial<Body> = {}): Body {
  return {
    submissionUuid: randomUUID(),
    sealedAt: SEALED_AT,
    appVersion: '1.0.0',
    user: BUDI,
    factory: 'F 1',
    cell: 'F1-1',
    po: 'CX-0902368685',
    partial: { number: 1, qty: 30 },
    counts: { rework: 10, bGrade: 2, noDefect: 18 },
    findings: [
      finding('D035', 5),
      finding('D049', 3, 'REWORK', 2),
      finding('D082', 3, 'B-GRADE', 3),
    ],
    ...overrides,
  };
}

const TOP: DefectId[] = ['D035', 'D049', 'D082'];

/** Two more mapped defects, so a body can carry a full Top 5. */
const EXTRA = [...new Set(mapping.map.map((e) => e.defectId))]
  .filter((id) => !['D035', 'D049', 'D071', 'D082'].includes(id))
  .slice(0, 2);

function fiveDefects(): { body: Body; photos: DefectId[] } {
  const b = body();
  b.findings.push(finding(EXTRA[0]!, 1, 'REWORK', 4), finding(EXTRA[1]!, 1, 'REWORK', 5));
  return { body: b, photos: [...TOP, ...EXTRA] };
}

const jpeg = (seed: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(seed)]);

interface Sent {
  json: string;
  photos: Map<DefectId, Buffer>;
}

/** The multipart request of doc 04 §4.1: the JSON part as a file part, as the tablet sends a Blob. */
function prepare(b: Body, photoIds: DefectId[] = [], seed = 'a'): Sent {
  const photos = new Map(photoIds.map((id) => [id, jpeg(`${b.submissionUuid}:${id}:${seed}`)]));
  const json = JSON.stringify({
    ...b,
    photos: photoIds.map((id) => ({
      defectId: id,
      part: `photo_${id}`,
      sha256: sha256Hex(photos.get(id)!),
    })),
  });
  return { json, photos };
}

function post(sent: Sent, t: Tablet, app: NestExpressApplication = main.app) {
  let req = request(app.getHttpServer())
    .post('/v1/submissions')
    .set('X-Device-Key', t.device.key)
    .set('Authorization', `Bearer ${t.token}`)
    .attach('submission', Buffer.from(sent.json), {
      filename: 'submission.json',
      contentType: 'application/json',
    });
  for (const [id, bytes] of sent.photos) {
    req = req.attach(`photo_${id}`, bytes, { filename: `${id}.jpg`, contentType: 'image/jpeg' });
  }
  return req;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest();
const fileOf = (key: string) => join(photoDir, ...key.split('/'));
const folderOf = (uuid: string) => join(photoDir, 'submissions', '2026', '10', uuid);
const filesOf = (uuid: string) => (existsSync(folderOf(uuid)) ? readdirSync(folderOf(uuid)) : []);

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await testDb.client.query<{ n: number }>(sql, params);
  return rows[0]!.n;
}
const submissionRows = (id: string) =>
  count('SELECT count(*)::int AS n FROM submissions WHERE id = $1', [id]);
const findingRows = (id: string) =>
  count('SELECT count(*)::int AS n FROM submission_findings WHERE submission_id = $1', [id]);
const photoRows = (id: string) =>
  count('SELECT count(*)::int AS n FROM submission_photos WHERE submission_id = $1', [id]);

/** Every photo row in the database points to a file holding exactly the bytes it names (doc 02 §6.2). */
async function expectEveryPhotoRowHasItsFile(): Promise<void> {
  const { rows } = await testDb.client.query<{ objectKey: string; sha256: Buffer }>(
    'SELECT object_key AS "objectKey", sha256 FROM submission_photos',
  );
  for (const row of rows) {
    expect(existsSync(fileOf(row.objectKey))).toBe(true);
    expect(sha256(readFileSync(fileOf(row.objectKey))).equals(row.sha256)).toBe(true);
  }
}

/** Written or repeated: the answer is in the spec and carries the doc 02 §9 totals. */
function expectWritten(res: Response, status: 200 | 201, uuid: string): void {
  expect(res.status).toBe(status);
  expectMatchesSpec(res, 'post', '/submissions');
  expect(res.body).toMatchObject({
    submissionUuid: uuid,
    status: 'written',
    displayNo: expect.stringMatching(/^M100-\d{6}$/) as string,
    writtenAt: expect.stringMatching(/\+07:00$/) as string,
  });
}

const result = (res: Response) => res.body as SubmissionResult;
type Row = Record<string, unknown>;

describe('POST /v1/submissions (doc 02 §6.1, doc 03 §5.4)', () => {
  it('stores the manual quantity example with server-derived ADR-019 totals and replays unchanged', async () => {
    const t = await tablet();
    const b = body({
      po: 'CX-0902368685',
      counts: { rework: 10, bGrade: 2, qtyInspection: 30 },
      partial: { number: 1, qty: 30 },
    });
    const sent = prepare(b, TOP);
    const res = await post(sent, t);
    expectWritten(res, 201, b.submissionUuid);
    expect(result(res).totals).toEqual({
      qtyInspection: 30,
      qtyAGrade: 19,
      qtyBGrade: 3,
      qtyDefect: 11,
      rft: 0.63333,
      defectRate: 0.36667,
    });
    const row = (
      await testDb.client.query<Row>(
        'SELECT counting_rule, qty_no_defect, qty_a_grade FROM submissions WHERE id = $1',
        [b.submissionUuid],
      )
    ).rows[0];
    expect(row).toEqual({ counting_rule: 'ADR-019', qty_no_defect: null, qty_a_grade: 19 });
    const repeat = await post(sent, t);
    expectWritten(repeat, 200, b.submissionUuid);
    expect(result(repeat).totals).toEqual(result(res).totals);
  });

  it.each([
    ['both count shapes', { rework: 10, bGrade: 2, qtyInspection: 30, noDefect: 18 }, null],
    ['neither count shape', { rework: 10, bGrade: 2 }, null],
    ['zero', { rework: 10, bGrade: 2, qtyInspection: 0 }, null],
    ['negative', { rework: 10, bGrade: 2, qtyInspection: -1 }, null],
    ['fraction', { rework: 10, bGrade: 2, qtyInspection: 30.5 }, null],
    ['string', { rework: 10, bGrade: 2, qtyInspection: '30' }, null],
    ['null', { rework: 10, bGrade: 2, qtyInspection: null }, null],
    [
      'empty with impossible partial',
      { rework: 10, bGrade: 2, qtyInspection: null },
      { number: 1, qty: 10 },
    ],
    ['below findings', { rework: 10, bGrade: 2, qtyInspection: 10 }, null],
    ['above partial', { rework: 10, bGrade: 2, qtyInspection: 31 }, { number: 1, qty: 30 }],
    ['above order', { rework: 10, bGrade: 2, qtyInspection: 1201 }, null],
    [
      'findings above maximum',
      { rework: 10, bGrade: 2, qtyInspection: 10 },
      { number: 1, qty: 10 },
    ],
  ])('rejects ADR-019 %s with 422 and no writes', async (_label, counts, partial) => {
    const t = await tablet();
    const b = body({ partial, po: 'CX-0902368685' });
    // Deliberately malformed wire input: do not constrain it to the domain type.
    const sent = prepare(b, TOP);
    sent.json = JSON.stringify({ ...JSON.parse(sent.json), counts });
    const res = await post(sent, t);
    const problem = expectProblem(res, 422, 'VALIDATION_FAILED');
    expect(problem.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'counts.qtyInspection', code: 'INVALID' }),
      ]),
    );
    if (_label === 'findings above maximum') {
      expect(problem.errors!.filter((e) => e.path === 'counts.qtyInspection')).toHaveLength(2);
    }
    expect(await submissionRows(b.submissionUuid)).toBe(0);
    expect(filesOf(b.submissionUuid)).toEqual([]);
  });

  it('accepts a manual all-good inspection without REWORK or B-GRADE taps', async () => {
    const t = await tablet(ANDI);
    const b = body({
      user: ANDI,
      counts: { rework: 0, bGrade: 0, qtyInspection: 5 },
      findings: [],
      partial: null,
    });
    const res = await post(prepare(b), t);
    expectWritten(res, 201, b.submissionUuid);
    expect(result(res).totals).toMatchObject({
      qtyInspection: 5,
      qtyDefect: 0,
      qtyAGrade: 5,
      rft: 1,
    });
  });

  it('writes the doc 02 §9 example from PSI lv.2 with its Top 5 photos: 201, totals, files', async () => {
    const t = await tablet();
    const b = body();
    const sent = prepare(b, TOP);
    const res = await post(sent, t);
    expectWritten(res, 201, b.submissionUuid);
    expect(result(res).totals).toEqual({
      qtyInspection: 30,
      qtyAGrade: 18,
      qtyBGrade: 3,
      qtyDefect: 11,
      rft: 0.6,
      defectRate: 0.36667,
    });

    const { rows } = await testDb.client.query(
      `SELECT device_id AS "deviceId", inspection_date::text AS "inspectionDate", photo_count AS "photoCount",
              encode(payload_sha256, 'hex') AS "payloadSha256", partial_no AS "partialNo", partial_qty AS "partialQty",
              counting_rule AS "countingRule", qty_no_defect AS "noDefect"
         FROM submissions WHERE id = $1`,
      [b.submissionUuid],
    );
    expect(rows[0]).toEqual({
      deviceId: t.device.id,
      inspectionDate: '2026-10-16',
      photoCount: 3,
      payloadSha256: sha256Hex(Buffer.from(sent.json)),
      partialNo: 1,
      partialQty: 30,
      countingRule: 'ADR-008',
      noDefect: 18,
    });
    expect(await findingRows(b.submissionUuid)).toBe(3);
    for (const [id, bytes] of sent.photos) {
      expect(readFileSync(fileOf(photoKey(b.submissionUuid, id, SEALED_AT))).equals(bytes)).toBe(
        true,
      );
    }
    expect(filesOf(b.submissionUuid).sort()).toEqual(['D035.jpg', 'D049.jpg', 'D082.jpg']);
  });

  it('writes a PSI lv.1 submission without photos', async () => {
    const t = await tablet(ANDI);
    const b = body({ user: ANDI });
    expectWritten(await post(prepare(b), t), 201, b.submissionUuid);
    expect(await photoRows(b.submissionUuid)).toBe(0);
    expect(filesOf(b.submissionUuid)).toEqual([]);
  });

  describe('idempotency (doc 04 §4.3, BR-06)', () => {
    it('answers the same UUID and bytes again with 200 and the stored result', async () => {
      const t = await tablet();
      const b = body();
      const sent = prepare(b, TOP);
      const first = await post(sent, t);
      expectWritten(first, 201, b.submissionUuid);
      const again = await post(sent, t);
      expectWritten(again, 200, b.submissionUuid);
      expect(again.body).toEqual(first.body);
      expect(await submissionRows(b.submissionUuid)).toBe(1);
    });

    it('writes one submission when the same request arrives six times at once', async () => {
      const t = await tablet();
      const b = body();
      const sent = prepare(b, TOP);
      const answers = await Promise.all(Array.from({ length: 6 }, () => post(sent, t)));
      expect(answers.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
      for (const r of answers) expectWritten(r, r.status as 200 | 201, b.submissionUuid);
      expect(new Set(answers.map((r) => result(r).displayNo)).size).toBe(1);
      expect(await submissionRows(b.submissionUuid)).toBe(1);
      expect(await findingRows(b.submissionUuid)).toBe(3);
      expect(await photoRows(b.submissionUuid)).toBe(3);
    });

    it('writes one submission when two API processes get it at once (ON CONFLICT)', async () => {
      const other = await startApp();
      const t = await tablet();
      const b = body();
      const sent = prepare(b, TOP);
      const answers = await Promise.all(
        Array.from({ length: 6 }, (_, i) => post(sent, t, i % 2 ? other.app : main.app)),
      );
      expect(answers.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
      expect(await submissionRows(b.submissionUuid)).toBe(1);
      expect(await findingRows(b.submissionUuid)).toBe(3);
      expect(await photoRows(b.submissionUuid)).toBe(3);
      await expectEveryPhotoRowHasItsFile();
    });

    it('refuses the same UUID with other bytes with 409 SUBMISSION_UUID_REUSED and writes nothing', async () => {
      const t = await tablet();
      const b = body();
      const sent = prepare(b, TOP);
      expectWritten(await post(sent, t), 201, b.submissionUuid);

      const changed = prepare({ ...b, appVersion: '1.0.1' }, TOP, 'other photo');
      const res = await post(changed, t);
      expectMatchesSpec(res, 'post', '/submissions');
      expectProblem(res, 409, 'SUBMISSION_UUID_REUSED');
      expect(await submissionRows(b.submissionUuid)).toBe(1);
      const { rows } = await testDb.client.query<{ appVersion: string }>(
        'SELECT app_version AS "appVersion" FROM submissions WHERE id = $1',
        [b.submissionUuid],
      );
      expect(rows[0]!.appVersion).toBe('1.0.0');
      for (const [id, bytes] of sent.photos) {
        expect(readFileSync(fileOf(photoKey(b.submissionUuid, id, SEALED_AT))).equals(bytes)).toBe(
          true,
        );
      }
    });

    it('refuses other bytes sent at the same moment without touching the winner’s photos', async () => {
      const t = await tablet();
      const b = body();
      const sent = prepare(b, TOP);
      const changed = prepare({ ...b, appVersion: '1.0.1' }, TOP, 'other photo');
      const answers = await Promise.all([post(sent, t), post(changed, t)]);
      expect(answers.map((r) => r.status).sort()).toEqual([201, 409]);
      await expectEveryPhotoRowHasItsFile();
    });
  });

  describe('crashes and retries (doc 02 §6.2)', () => {
    afterEach(async () => {
      store.arm(null);
      main.database.failure = undefined;
      await main.readiness.check();
    });

    it('a store that fails after two photos leaves no row; the retry completes it once', async () => {
      const t = await tablet();
      const { body: b, photos } = fiveDefects();
      const sent = prepare(b, photos);

      store.arm(2);
      const failed = await post(sent, t);
      expectMatchesSpec(failed, 'post', '/submissions');
      expectProblem(failed, 503, 'PHOTO_STORE_UNAVAILABLE');
      expect(Number(failed.headers['retry-after'])).toBe(30);
      expect(await submissionRows(b.submissionUuid)).toBe(0);
      expect(filesOf(b.submissionUuid)).toHaveLength(2);

      store.arm(null);
      await main.readiness.check();
      expectWritten(await post(sent, t), 201, b.submissionUuid);
      expect(await submissionRows(b.submissionUuid)).toBe(1);
      expect(await findingRows(b.submissionUuid)).toBe(5);
      expect(await photoRows(b.submissionUuid)).toBe(5);
      // One file per photo, and no temp file left behind.
      expect(filesOf(b.submissionUuid).sort()).toEqual(photos.map((id) => `${id}.jpg`).sort());
      await expectEveryPhotoRowHasItsFile();
    });

    it.each([
      ['a server error: 500 INTERNAL', new Error('Injected before COMMIT'), 500, 'INTERNAL'],
      [
        'a lost connection: 503 DB_UNAVAILABLE',
        Object.assign(new Error('terminating connection'), { code: '57P01' }),
        503,
        'DB_UNAVAILABLE',
      ],
    ] as const)(
      'a failure just before COMMIT (%s) leaves nothing; the retry writes it once',
      async (_name, failure, status, code) => {
        const t = await tablet();
        const { body: b, photos } = fiveDefects();
        const sent = prepare(b, photos);

        main.database.failure = failure;
        const failed = await post(sent, t);
        expectProblem(failed, status, code);
        expect(await submissionRows(b.submissionUuid)).toBe(0);
        expect(await findingRows(b.submissionUuid)).toBe(0);
        // The photos are in the store already; the retry overwrites them with the same bytes.
        expect(filesOf(b.submissionUuid)).toHaveLength(5);

        await main.readiness.check();
        expectWritten(await post(sent, t), 201, b.submissionUuid);
        expect(await submissionRows(b.submissionUuid)).toBe(1);
        expect(await findingRows(b.submissionUuid)).toBe(5);
        expect(await photoRows(b.submissionUuid)).toBe(5);
        expect(filesOf(b.submissionUuid)).toHaveLength(5);
        await expectEveryPhotoRowHasItsFile();
      },
    );
  });

  it('keeps the snapshot of the master data at write time when master data changes afterwards', async () => {
    const t = await tablet();
    const b = body();
    expectWritten(await post(prepare(b, TOP), t), 201, b.submissionUuid);

    const snapshot = async () => ({
      submission: (
        await testDb.client.query<Row>(
          `SELECT username, level, factory, cell, po, article, model, destination, order_qty, podd::text, crd::text
             FROM submissions WHERE id = $1`,
          [b.submissionUuid],
        )
      ).rows[0],
      findings: (
        await testDb.client.query<Row>(
          `SELECT defect_id, defect_name, severity FROM submission_findings
            WHERE submission_id = $1 ORDER BY defect_id`,
          [b.submissionUuid],
        )
      ).rows,
    });
    const master = async () => ({
      po: (
        await testDb.client.query<Row>(
          `SELECT po, article, model, destination, order_qty, podd::text, crd::text FROM pos WHERE po = $1`,
          [b.po],
        )
      ).rows[0],
      defects: (
        await testDb.client.query<Row>(
          `SELECT id AS defect_id, name AS defect_name, severity FROM defects WHERE id = ANY($1) ORDER BY id`,
          [TOP],
        )
      ).rows,
    });

    const before = await snapshot();
    const atWrite = await master();
    expect(before.submission).toEqual({
      username: 'TEST BUDI',
      level: 'PSI lv.2',
      factory: 'F 1',
      cell: 'F1-1',
      ...atWrite.po,
    });
    expect(before.findings).toEqual(atWrite.defects);

    await testDb.client.query('BEGIN');
    try {
      await testDb.client.query(
        `UPDATE pos SET article = 'CHANGED', model = 'CHANGED', destination = 'CHANGED', order_qty = 99999,
                        podd = '2030-01-01', crd = '2030-01-02' WHERE po = $1`,
        [b.po],
      );
      await testDb.client.query(
        `UPDATE defects SET name = name || ' (renamed)',
                            severity = CASE severity WHEN 'CRITICAL' THEN 'MINOR' ELSE 'CRITICAL' END
          WHERE id = ANY($1)`,
        [TOP],
      );
      await testDb.client.query(`UPDATE cells SET active = false WHERE code = 'F1-1'`);
      expect(await master()).not.toEqual(atWrite);
      expect(await snapshot()).toEqual(before);
    } finally {
      await testDb.client.query('ROLLBACK');
    }
  });

  describe('unavailable (doc 03 §5.7)', () => {
    afterEach(async () => {
      await testDb.allowConnections(true);
      await main.readiness.check();
    });

    it('answers 503 DB_UNAVAILABLE while the database is down, and writes after it is back', async () => {
      const t = await tablet();
      // The device key guard remembers a tablet it has seen, so the request reaches the write.
      const seen = body();
      expectWritten(await post(prepare(seen, TOP), t), 201, seen.submissionUuid);
      const b = body();
      const sent = prepare(b, TOP);

      await testDb.allowConnections(false);
      const down = await post(sent, t);
      expectMatchesSpec(down, 'post', '/submissions');
      expectProblem(down, 503, 'DB_UNAVAILABLE');
      expect(Number(down.headers['retry-after'])).toBe(30);
      expect(main.readiness.current().submitEnabled).toBe(false);
      // While the DB check fails, Submit PO answers the same without trying.
      expectProblem(await post(sent, t), 503, 'DB_UNAVAILABLE');

      await testDb.allowConnections(true);
      await main.readiness.check();
      expectWritten(await post(sent, t), 201, b.submissionUuid);
    });

    it('answers 503 PHOTO_STORE_UNAVAILABLE while the photo folder is gone, and writes nothing', async () => {
      const t = await tablet();
      const b = body();
      const sent = prepare(b, TOP);
      const away = `${photoDir}-away`;
      renameSync(photoDir, away);
      try {
        const res = await post(sent, t);
        expectMatchesSpec(res, 'post', '/submissions');
        expectProblem(res, 503, 'PHOTO_STORE_UNAVAILABLE');
        expect(await submissionRows(b.submissionUuid)).toBe(0);
      } finally {
        renameSync(away, photoDir);
      }
      await main.readiness.check();
      expectWritten(await post(sent, t), 201, b.submissionUuid);
    });

    it('answers 503 SUBMIT_DISABLED with the reason while settings.submit_enabled is false', async () => {
      const t = await tablet();
      await testDb.client.query(`UPDATE settings SET value = 'false' WHERE key = 'submit_enabled'`);
      try {
        await main.readiness.check();
        const res = await post(prepare(body(), TOP), t);
        expectMatchesSpec(res, 'post', '/submissions');
        const problem = expectProblem(res, 503, 'SUBMIT_DISABLED');
        expect(problem.detail).toBe(
          'Pengiriman sedang dinonaktifkan: settings.submit_enabled is false',
        );
        expect(Number(res.headers['retry-after'])).toBe(30);
      } finally {
        await testDb.client.query(
          `UPDATE settings SET value = 'true' WHERE key = 'submit_enabled'`,
        );
      }
    });
  });

  it('logs one line per submission with the NFR-10 fields, never a key, token or photo', async () => {
    const t = await tablet();
    const b = body();
    const sent = prepare(b, TOP);
    const first = await post(sent, t);
    await post(sent, t);
    await post(prepare({ ...b, appVersion: '9' }, TOP), t);

    const lines = logLines.filter(
      (l) => l.msg === 'Submit PO' && l.submissionUuid === b.submissionUuid,
    );
    expect(lines.map((l) => [l.result, l.status])).toEqual([
      ['written', 201],
      ['already_written', 200],
      ['SUBMISSION_UUID_REUSED', 409],
    ]);
    for (const line of lines) {
      expect(line).toMatchObject({
        submissionUuid: b.submissionUuid,
        username: 'TEST BUDI',
        po: 'CX-0902368685',
        photoCount: 3,
        durationMs: expect.any(Number) as number,
      });
    }
    expect(lines[0]!.displayNo).toBe(result(first).displayNo);
    const text = JSON.stringify(logLines);
    expect(text).not.toContain(t.device.key);
    expect(text).not.toContain(t.token);
    for (const bytes of sent.photos.values()) expect(text).not.toContain(bytes.toString('base64'));
  });
});
