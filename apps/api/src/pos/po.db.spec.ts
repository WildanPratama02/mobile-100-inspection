import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Po } from '@m100/shared';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../app';
import { AppModule } from '../app.module';
import { TokenSigner } from '../auth/jwt';
import { TabletTokens } from '../auth/tablet-token';
import { Database } from '../db/database';
import { PgPoRepository, type PoInput } from '../repositories/po.repository';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { registerDevice, type TestDevice } from '../testing/devices';
import { testConfig, testJwtKey } from '../testing/env';
import { expectMatchesSpec, expectProblem } from '../testing/openapi';
import { RATE_LIMIT } from '../throttle/device-throttler.guard';
import { PO_SEARCH } from './po.service';

let testDb: TestDatabase;
let photoDir: string;
let app: NestExpressApplication;
let tablet: TestDevice;
let token: string;
const tokens = () => new TabletTokens(new TokenSigner(testJwtKey()));

function tokenFor(device: TestDevice): string {
  return tokens().issue({
    sub: 'TEST BUDI',
    lvl: 'PSI lv.2',
    fac: 'F 1',
    cel: 'F1-1',
    dev: device.id,
  }).token;
}

const po = (fields: Partial<PoInput> & Pick<PoInput, 'po'>): PoInput => ({
  article: 'ZZ0000',
  model: 'PLAIN',
  destination: 'USA',
  orderQty: 100,
  podd: null,
  crd: null,
  finished: null,
  ...fields,
});

const RUNNER: Po = {
  po: '0902028839',
  article: 'IH1234',
  model: 'RUNNER X',
  destination: 'JAPAN ',
  orderQty: 10002,
  podd: '2026-01-12',
  crd: null,
};
const COURT: Po = {
  po: 'CX-0902368685',
  article: 'JQ9876',
  model: 'COURT',
  destination: '',
  orderQty: 1,
  podd: null,
  crd: '2026-12-31',
};

const POS: PoInput[] = [
  { ...RUNNER, finished: false },
  { ...COURT, finished: null },
  po({ po: '0902288390', podd: '2026-03-01' }),
  po({ po: '0903338839', podd: '2026-05-01' }),
  po({ po: '0909998839', podd: '2026-12-01' }),
  // 25 POs sharing the article MANY01, for the result limit.
  ...Array.from({ length: 25 }, (_, i) =>
    po({ po: `07000000${String(i).padStart(2, '0')}`, article: 'MANY01' }),
  ),
];

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: true });
  photoDir = mkdtempSync(join(tmpdir(), 'm100-pos-'));
  await new PgPoRepository(new Database(testDb.pool('m100_app'))).upsertMany(
    POS,
    'import:ALL_PO_MASTER.csv',
  );
  await testDb.client.query(`UPDATE pos SET active = false WHERE po = '0909998839'`);
  tablet = await registerDevice(testDb.client, 'Tablet A');
  token = tokenFor(tablet);

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
});

afterAll(async () => {
  await testDb?.allowConnections(true).catch(() => undefined);
  await app?.close();
  await testDb?.drop();
  rmSync(photoDir, { recursive: true, force: true });
});

const get = (path: string, device: TestDevice = tablet, bearer: string = token) =>
  request(app.getHttpServer())
    .get(path)
    .set('X-Device-Key', device.key)
    .set('Authorization', `Bearer ${bearer}`);
const search = (query: Record<string, string>) =>
  get(`/v1/pos?${new URLSearchParams(query).toString()}`);

describe('GET /v1/pos (doc 04 §3.3)', () => {
  it('needs the device key and the user token (doc 04 §2)', async () => {
    const noToken = await request(app.getHttpServer())
      .get('/v1/pos?q=8839')
      .set('X-Device-Key', tablet.key);
    expectMatchesSpec(noToken, 'get', '/pos');
    expectProblem(noToken, 401, 'TOKEN_INVALID');

    const noKey = await request(app.getHttpServer())
      .get('/v1/pos?q=8839')
      .set('Authorization', `Bearer ${token}`);
    expectMatchesSpec(noKey, 'get', '/pos');
    expectProblem(noKey, 401, 'DEVICE_KEY_INVALID');
  });

  it.each([
    ['2 characters', { q: '88' }],
    ['2 characters after trimming', { q: '  88  ' }],
    ['no q', {}],
    ['41 characters', { q: '9'.repeat(41) }],
    ['limit 0', { q: '8839', limit: '0' }],
    ['limit 21', { q: '8839', limit: '21' }],
    ['limit not a number', { q: '8839', limit: 'abc' }],
    ['limit not an integer', { q: '8839', limit: '1.5' }],
    ['an unknown parameter', { q: '8839', page: '2' }],
  ])('refuses %s with 422 VALIDATION_FAILED', async (_name, query) => {
    const res = await search(query);
    expectMatchesSpec(res, 'get', '/pos');
    const body = expectProblem(res, 422, 'VALIDATION_FAILED');
    expect(body.errors?.length).toBeGreaterThan(0);
    expect(body.detail).toMatch(/^Data tidak lengkap: /);
  });

  it('refuses a repeated q', async () => {
    const res = await get('/v1/pos?q=8839&q=0902');
    expectProblem(res, 422, 'VALIDATION_FAILED');
  });

  it('returns at most 20 results, or `limit`', async () => {
    const all = await search({ q: 'many01' });
    expect(all.status).toBe(200);
    expectMatchesSpec(all, 'get', '/pos');
    expect((all.body as { items: Po[] }).items).toHaveLength(PO_SEARCH.maxResults);

    const five = await search({ q: 'MANY01', limit: '5' });
    expect((five.body as { items: Po[] }).items).toHaveLength(5);
  });

  it('puts the POs ending with the typed digits first and leaves out deactivated POs', async () => {
    const res = await search({ q: ' 8839 ' });
    expect(res.status).toBe(200);
    expectMatchesSpec(res, 'get', '/pos');
    expect((res.body as { items: Po[] }).items.map((p) => p.po)).toEqual([
      '0903338839',
      '0902028839',
      '0902288390',
    ]);
  });

  it('keeps leading zeros and prefixes, and returns model and destination byte for byte', async () => {
    const runner = await search({ q: '0902028839' });
    expectMatchesSpec(runner, 'get', '/pos');
    expect(runner.body).toEqual({ items: [RUNNER] });

    const court = await search({ q: 'cx-0902368685' });
    expectMatchesSpec(court, 'get', '/pos');
    expect(court.body).toEqual({ items: [COURT] });

    const byModel = await search({ q: 'runner x' });
    expect(byModel.body).toEqual({ items: [RUNNER] });
  });

  it('answers an empty list when nothing matches', async () => {
    const res = await search({ q: 'nothing like this' });
    expect(res.status).toBe(200);
    expectMatchesSpec(res, 'get', '/pos');
    expect(res.body).toEqual({ items: [] });
  });
});

describe('GET /v1/pos/{po} (doc 04 §3.3)', () => {
  it('returns one PO by its exact number, leading zeros and prefixes kept', async () => {
    const runner = await get('/v1/pos/0902028839');
    expect(runner.status).toBe(200);
    expectMatchesSpec(runner, 'get', '/pos/{po}');
    expect(runner.body).toEqual(RUNNER);

    const court = await get(`/v1/pos/${encodeURIComponent('CX-0902368685')}`);
    expect(court.status).toBe(200);
    expectMatchesSpec(court, 'get', '/pos/{po}');
    expect(court.body).toEqual(COURT);
  });

  it.each([
    ['without the leading zero', '902028839'],
    ['in another case', 'cx-0902368685'],
    ['deactivated', '0909998839'],
    ['unknown', '0000000000'],
  ])('answers 404 PO_NOT_FOUND for a PO %s', async (_name, number) => {
    const res = await get(`/v1/pos/${encodeURIComponent(number)}`);
    expectMatchesSpec(res, 'get', '/pos/{po}');
    const body = expectProblem(res, 404, 'PO_NOT_FOUND');
    expect(body.detail).toBe('PO tidak ditemukan di master PO.');
  });

  it('needs the user token', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/pos/0902028839')
      .set('X-Device-Key', tablet.key);
    expectMatchesSpec(res, 'get', '/pos/{po}');
    expectProblem(res, 401, 'TOKEN_INVALID');
  });
});

describe('PO search over the full PO set (doc 08 T2.6)', () => {
  /** The size of the export of 21 Oct 2026 (doc 02 §3.3). */
  const FULL_SET = 33_996;
  const SEARCHES = 200;
  const WARM_UP = 10;

  /** A small deterministic generator (mulberry32), so every run searches the same data. */
  function random(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  }

  const MODELS = [
    'RUNNER X',
    'COURT CLASSIC',
    'ULTRA BOOST 22',
    'SAMBA OG',
    'GAZELLE',
    'FORUM LOW',
    'SUPERSTAR',
    'STAN SMITH',
    'TERREX SWIFT',
    'ADIZERO PRO',
  ];
  let fullSet: PoInput[];
  let rand: () => number;
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const digits = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 10)).join('');
  const letters = (n: number) =>
    Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(rand() * 26))).join('');

  beforeAll(async () => {
    rand = random(26);
    const seen = new Set(POS.map((p) => p.po));
    fullSet = [];
    while (fullSet.length < FULL_SET - POS.length) {
      const number = `${rand() < 0.03 ? 'CX-' : ''}09${digits(8)}`;
      if (seen.has(number)) continue;
      seen.add(number);
      const day = 1 + Math.floor(rand() * 28);
      fullSet.push(
        po({
          po: number,
          article: `${letters(2)}${digits(4)}`,
          model: pick(MODELS),
          destination: pick(['JAPAN', 'USA', 'GERMANY', 'KOREA']),
          orderQty: 1 + Math.floor(rand() * 20_000),
          podd:
            rand() < 0.1
              ? null
              : `202${5 + Math.floor(rand() * 3)}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        }),
      );
    }
    await new PgPoRepository(new Database(testDb.pool('m100_app'))).upsertMany(
      fullSet,
      'import:ALL_PO_MASTER.csv',
    );
    await testDb.client.query('ANALYZE pos');
  }, 120_000);

  it(`answers ${SEARCHES} realistic searches with p95 under 100 ms`, async () => {
    // Mostly the last 3–4 digits of a PO, as PSI type them; some article and model text.
    const queries = Array.from({ length: WARM_UP + SEARCHES }, () => {
      const r = rand();
      const target = pick(fullSet);
      if (r < 0.75) return target.po.slice(-(3 + Math.floor(rand() * 2)));
      if (r < 0.9) return target.article.slice(0, 4).toLowerCase();
      return target.model.slice(0, 5);
    });
    // The rate limit is per device (doc 04 §7): spread the requests over enough tablets.
    const perDevice = RATE_LIMIT.limit - 5;
    const devices: TestDevice[] = [];
    // One at a time: `testDb.client` is a single connection.
    for (let i = 0; i < Math.ceil(queries.length / perDevice); i++) {
      devices.push(await registerDevice(testDb.client, `Load ${i}`));
    }
    const bearers = devices.map(tokenFor);

    const times: number[] = [];
    for (const [i, q] of queries.entries()) {
      const d = Math.floor(i / perDevice);
      const started = performance.now();
      const res = await get(`/v1/pos?q=${encodeURIComponent(q)}`, devices[d], bearers[d]);
      const ms = performance.now() - started;
      expect(res.status).toBe(200);
      expect((res.body as { items: Po[] }).items.length).toBeGreaterThan(0);
      if (i >= WARM_UP) times.push(ms);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    const p50 = times[Math.ceil(times.length * 0.5) - 1]!;
    process.stdout.write(
      `GET /pos over ${FULL_SET} POs, ${SEARCHES} searches: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms\n`,
    );
    expect(p95).toBeLessThan(100);
  }, 120_000);
});

describe('GET /v1/pos with the database down (doc 03 §5.7)', () => {
  it('answers 503 DB_UNAVAILABLE', async () => {
    // A request first, so the device guard knows the tablet when the database is gone.
    expect((await search({ q: '8839' })).status).toBe(200);
    await testDb.allowConnections(false);
    try {
      const res = await search({ q: '8839' });
      expectMatchesSpec(res, 'get', '/pos');
      expectProblem(res, 503, 'DB_UNAVAILABLE');

      const one = await get('/v1/pos/0902028839');
      expectMatchesSpec(one, 'get', '/pos/{po}');
      expectProblem(one, 503, 'DB_UNAVAILABLE');
    } finally {
      await testDb.allowConnections(true);
    }
  });
});
