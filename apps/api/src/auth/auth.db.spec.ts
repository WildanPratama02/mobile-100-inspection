import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, Get, Req } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../app';
import { AppModule } from '../app.module';
import { Database } from '../db/database';
import { importMaster, pgImportRepositories } from '../import/import-master';
import { parseMaster } from '../import/parse-master';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { registerDevice, type TestDevice } from '../testing/devices';
import { testConfig, testJwtKey } from '../testing/env';
import { fixtureTables } from '../testing/master-fixtures';
import { expectMatchesSpec, expectProblem } from '../testing/openapi';
import { RATE_LIMIT } from '../throttle/device-throttler.guard';
import type { AuthRequest } from './auth.decorator';
import { KEY_FAILURES } from './device-key.guard';
import { TokenSigner } from './jwt';
import { type TabletClaims, TabletTokens } from './tablet-token';

/** A route that needs device key and token, as `/pos` and `/submissions` will (T2.6, T3.3). */
@Controller('test-tablet')
class TabletProbeController {
  @Get('me')
  me(@Req() req: AuthRequest): { claims: TabletClaims | undefined } {
    return { claims: req.tablet };
  }
}

const DAY = 24 * 60 * 60 * 1000;
let testDb: TestDatabase;
let photoDir: string;
let app: NestExpressApplication;
let tablet: TestDevice;
let other: TestDevice;
/** The login tests' own tablet, so their many requests stay out of `tablet`'s rate budget. */
let kiosk: TestDevice;
const tokens = () => new TabletTokens(new TokenSigner(testJwtKey()));

const LOGIN = { username: 'TEST BUDI', level: 'PSI lv.2', factory: 'F 1', cell: 'F1-1' };
const http = () => request(app.getHttpServer());

/** Every test sends from its own address, so the failed-key limit of one test does not touch another. */
let ipCounter = 0;
const nextIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

function claimsOf(device: TestDevice, overrides: Partial<TabletClaims> = {}): TabletClaims {
  return {
    sub: 'TEST BUDI',
    lvl: 'PSI lv.2',
    fac: 'F 1',
    cel: 'F1-1',
    dev: device.id,
    ...overrides,
  };
}

/** A token as the API would have issued it `daysAgo` days ago. */
function tokenIssued(daysAgo: number, device: TestDevice = tablet): string {
  return tokens().issue(claimsOf(device), new Date(Date.now() - daysAgo * DAY)).token;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: true });
  photoDir = mkdtempSync(join(tmpdir(), 'm100-auth-'));
  const db = new Database(testDb.pool('m100_app'));
  await importMaster(db, pgImportRepositories(db), parseMaster(await fixtureTables()), {
    dryRun: false,
  });
  tablet = await registerDevice(testDb.client, 'Tablet A');
  other = await registerDevice(testDb.client, 'Tablet B');
  kiosk = await registerDevice(testDb.client, 'Tablet C');
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forConfig(
        testConfig({
          databaseUrl: testDb.url('m100_app'),
          photoStore: { kind: 'disk', dir: photoDir },
        }),
      ),
    ],
    controllers: [TabletProbeController],
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

describe('device key (doc 04 §2, ADR-014)', () => {
  it('/health needs no key', async () => {
    const res = await http().get('/v1/health');
    expect(res.status).toBe(200);
  });

  it.each([
    ['get', '/system/status', '/v1/system/status'],
    ['get', '/master-data', '/v1/master-data'],
    ['post', '/auth/login', '/v1/auth/login'],
  ] as const)('%s %s refuses a missing, malformed or unknown key', async (method, path, url) => {
    const ip = nextIp();
    for (const key of [undefined, 'not-a-key', 'A'.repeat(43)]) {
      let req = http()[method](url).set('X-Forwarded-For', ip);
      if (key !== undefined) req = req.set('X-Device-Key', key);
      const res = method === 'post' ? await req.send(LOGIN) : await req;
      expectProblem(res, 401, 'DEVICE_KEY_INVALID');
      expectMatchesSpec(res, method, path);
      expect(res.body).toMatchObject({ detail: 'Tablet belum terdaftar. Hubungi admin.' });
    }
  });

  it('lets a registered tablet in and records when it was last seen', async () => {
    const res = await http().get('/v1/system/status').set('X-Device-Key', tablet.key);
    expect(res.status).toBe(200);
    const { rows } = await testDb.client.query<{ last_seen_at: Date | null }>(
      'SELECT last_seen_at FROM devices WHERE id = $1',
      [tablet.id],
    );
    expect(rows[0]!.last_seen_at).toBeInstanceOf(Date);
  });

  it(`refuses the ${KEY_FAILURES.limit + 1}st failed key from one address within a minute, with Retry-After`, async () => {
    const ip = nextIp();
    for (let i = 0; i < KEY_FAILURES.limit; i++) {
      const res = await http()
        .get('/v1/system/status')
        .set('X-Forwarded-For', ip)
        .set('X-Device-Key', `${'B'.repeat(42)}${i % 10}`);
      expectProblem(res, 401, 'DEVICE_KEY_INVALID');
    }
    const blocked = await http()
      .get('/v1/system/status')
      .set('X-Forwarded-For', ip)
      .set('X-Device-Key', 'C'.repeat(43));
    expectProblem(blocked, 429, 'RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60);
    // While blocked, no key is tried from that address at all, not even a right one.
    const right = await http()
      .get('/v1/system/status')
      .set('X-Forwarded-For', ip)
      .set('X-Device-Key', tablet.key);
    expectProblem(right, 429, 'RATE_LIMITED');
    const elsewhere = await http()
      .get('/v1/system/status')
      .set('X-Forwarded-For', nextIp())
      .set('X-Device-Key', tablet.key);
    expect(elsewhere.status).toBe(200);
  });

  it('counts the request budget per device (doc 04 §7)', async () => {
    const device = await registerDevice(testDb.client);
    for (let i = 0; i < RATE_LIMIT.limit; i++) {
      // Two addresses, one device: still one budget.
      const res = await http()
        .get('/v1/system/status')
        .set('X-Forwarded-For', i % 2 ? '10.200.0.1' : '10.200.0.2')
        .set('X-Device-Key', device.key);
      expect(res.status).toBe(200);
    }
    const blocked = await http().get('/v1/system/status').set('X-Device-Key', device.key);
    expectProblem(blocked, 429, 'RATE_LIMITED');
  });
});

describe('POST /v1/auth/login (doc 04 §3.1)', () => {
  const login = (body: object, device: TestDevice = kiosk) =>
    http().post('/v1/auth/login').set('X-Device-Key', device.key).send(body);

  it('logs an active PSI in with a 30-day token for this tablet', async () => {
    const before = Date.now();
    const res = await login(LOGIN);
    expect(res.status).toBe(200);
    expectMatchesSpec(res, 'post', '/auth/login');
    const body = res.body as { token: string; expiresAt: string };
    expect(res.body).toMatchObject({
      user: { username: 'TEST BUDI', level: 'PSI lv.2' },
      factory: 'F 1',
      cell: 'F1-1',
    });
    expect(body.expiresAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+07:00$/);
    const expires = Date.parse(body.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 + 30 * DAY);
    expect(expires).toBeLessThanOrEqual(Date.now() + 30 * DAY);

    const me = await http()
      .get('/v1/test-tablet/me')
      .set('X-Device-Key', kiosk.key)
      .set('Authorization', `Bearer ${body.token}`);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ claims: claimsOf(kiosk) });
  });

  it.each([
    ['an unknown name', { username: 'NOBODY' }],
    ['a name with the other level', { username: 'TEST ANDI', level: 'PSI lv.2' }],
    ['a name in another case', { username: 'test budi' }],
    ['an unknown name with an unknown cell (user first)', { username: 'NOBODY', cell: 'F9-9' }],
  ])('answers 422 USER_NOT_FOUND for %s', async (_name, change) => {
    const res = await login({ ...LOGIN, ...change });
    const problem = expectProblem(res, 422, 'USER_NOT_FOUND');
    expectMatchesSpec(res, 'post', '/auth/login');
    expect(problem.detail).toBe('Nama tidak ada di daftar PSI.');
  });

  it.each([
    ['an unknown cell', { cell: 'F9-9' }],
    ['a cell of another factory', { factory: 'F 2' }],
    ['a factory that is not in the master data', { factory: 'PWA', cell: 'PWA-1' }],
  ])('answers 422 CELL_NOT_FOUND for %s', async (_name, change) => {
    const res = await login({ ...LOGIN, ...change });
    const problem = expectProblem(res, 422, 'CELL_NOT_FOUND');
    expectMatchesSpec(res, 'post', '/auth/login');
    expect(problem.detail).toBe('Factory/Cell tidak ditemukan.');
  });

  it('refuses a deactivated PSI, cell or factory', async () => {
    await testDb.client.query(
      `UPDATE psi_users SET active = false WHERE username = 'TEST DEWI' AND level = 'PSI lv.1'`,
    );
    await testDb.client.query(`UPDATE cells SET active = false WHERE code = 'F1-2'`);
    await testDb.client.query(`UPDATE factories SET active = false WHERE name = 'F 2'`);
    expectProblem(
      await login({ ...LOGIN, username: 'TEST DEWI', level: 'PSI lv.1' }),
      422,
      'USER_NOT_FOUND',
    );
    expect((await login({ ...LOGIN, username: 'TEST DEWI', level: 'PSI lv.2' })).status).toBe(200);
    expectProblem(await login({ ...LOGIN, cell: 'F1-2' }), 422, 'CELL_NOT_FOUND');
    expectProblem(await login({ ...LOGIN, factory: 'F 2', cell: 'F2-1' }), 422, 'CELL_NOT_FOUND');
  });

  it.each([
    ['an unknown field', { ...LOGIN, role: 'admin' }, 'UNKNOWN_FIELD'],
    ['a missing field', { username: 'TEST BUDI', level: 'PSI lv.2', factory: 'F 1' }, 'REQUIRED'],
    ['a level that does not exist', { ...LOGIN, level: 'CFA' }, 'INVALID'],
    ['an empty name', { ...LOGIN, username: '' }, 'INVALID'],
  ])('answers 422 VALIDATION_FAILED for %s', async (_name, body, code) => {
    const res = await login(body);
    const problem = expectProblem(res, 422, 'VALIDATION_FAILED');
    expectMatchesSpec(res, 'post', '/auth/login');
    expect(problem.errors?.map((e) => e.code)).toEqual([code]);
    expect(problem.detail).toMatch(/^Data tidak lengkap: /);
  });
});

describe('token (doc 04 §2)', () => {
  const me = (token: string | undefined, device: TestDevice = tablet) => {
    const req = http().get('/v1/test-tablet/me').set('X-Device-Key', device.key);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  it('is required on tablet routes: none or a broken one is TOKEN_INVALID', async () => {
    expectProblem(await me(undefined), 401, 'TOKEN_INVALID');
    expectProblem(await me('x.y.z'), 401, 'TOKEN_INVALID');
  });

  it('is TOKEN_EXPIRED after 30 days', async () => {
    expect((await me(tokenIssued(29))).status).toBe(200);
    const res = await me(tokenIssued(31));
    const problem = expectProblem(res, 401, 'TOKEN_EXPIRED');
    expect(problem.retryable).toBe(true);
  });

  it('is TOKEN_INVALID with another tablet’s key', async () => {
    expectProblem(await me(tokenIssued(1, tablet), other), 401, 'TOKEN_INVALID');
  });

  it('is TOKEN_INVALID when signed for the admin app', async () => {
    const admin = new TokenSigner(testJwtKey()).sign(
      { ...claimsOf(tablet) },
      {
        audience: 'admin',
        now: new Date(),
        lifetimeSeconds: 8 * 60 * 60,
      },
    );
    expectProblem(await me(admin.token), 401, 'TOKEN_INVALID');
  });
});

describe('POST /v1/auth/refresh (doc 04 §2, A7)', () => {
  const refresh = (token: string | undefined, device: TestDevice = tablet) => {
    const req = http().post('/v1/auth/refresh').set('X-Device-Key', device.key);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  it('gives a new 30-day token with the same claims when fewer than 7 days remain', async () => {
    const old = tokenIssued(24);
    const res = await refresh(old);
    expect(res.status).toBe(200);
    expectMatchesSpec(res, 'post', '/auth/refresh');
    const body = res.body as { token: string; expiresAt: string };
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(res.body).toMatchObject({
      user: { username: 'TEST BUDI', level: 'PSI lv.2' },
      factory: 'F 1',
      cell: 'F1-1',
    });
    expect(body.token).not.toBe(old);
    expect(
      (
        await http()
          .get('/v1/test-tablet/me')
          .set('X-Device-Key', tablet.key)
          .set('Authorization', `Bearer ${body.token}`)
      ).body,
    ).toEqual({ claims: claimsOf(tablet) });
  });

  it('also takes a token that expired less than 30 days ago (outbox: TOKEN_EXPIRED → refresh)', async () => {
    const res = await refresh(tokenIssued(40));
    expect(res.status).toBe(200);
    expectMatchesSpec(res, 'post', '/auth/refresh');
  });

  it('answers TOKEN_INVALID for a token that expired more than 30 days ago', async () => {
    const res = await refresh(tokenIssued(61));
    expectProblem(res, 401, 'TOKEN_INVALID');
    expectMatchesSpec(res, 'post', '/auth/refresh');
  });

  it('answers TOKEN_INVALID without a token or with another tablet’s token', async () => {
    expectProblem(await refresh(undefined), 401, 'TOKEN_INVALID');
    expectProblem(await refresh(tokenIssued(1, tablet), other), 401, 'TOKEN_INVALID');
  });

  it('does not check the master data again', async () => {
    await testDb.client.query(`UPDATE psi_users SET active = false WHERE username = 'TEST BUDI'`);
    try {
      expect((await refresh(tokenIssued(24))).status).toBe(200);
    } finally {
      await testDb.client.query(`UPDATE psi_users SET active = true WHERE username = 'TEST BUDI'`);
    }
  });
});

describe('a revoked tablet (doc 03 §6)', () => {
  it('is refused at once with DEVICE_KEY_INVALID, also with an unexpired token', async () => {
    const lost = await registerDevice(testDb.client, 'Tablet lost');
    const res = await http().post('/v1/auth/login').set('X-Device-Key', lost.key).send(LOGIN);
    const { token } = res.body as { token: string };
    const me = () =>
      http()
        .get('/v1/test-tablet/me')
        .set('X-Device-Key', lost.key)
        .set('Authorization', `Bearer ${token}`);
    expect((await me()).status).toBe(200);

    await testDb.client.query('UPDATE devices SET revoked_at = now() WHERE id = $1', [lost.id]);
    expectProblem(await me(), 401, 'DEVICE_KEY_INVALID');
    expectProblem(
      await http()
        .post('/v1/auth/refresh')
        .set('X-Device-Key', lost.key)
        .set('Authorization', `Bearer ${token}`),
      401,
      'DEVICE_KEY_INVALID',
    );
    expectProblem(
      await http().get('/v1/master-data').set('X-Device-Key', lost.key),
      401,
      'DEVICE_KEY_INVALID',
    );
  });
});

describe('while the database is down (doc 03 §5.7)', () => {
  it('lets a tablet it already knows reach /master-data, and answers 503 DB_UNAVAILABLE for an unknown key', async () => {
    expect((await http().get('/v1/master-data').set('X-Device-Key', tablet.key)).status).toBe(200);
    const unseen = await registerDevice(testDb.client);
    await testDb.allowConnections(false);
    try {
      expect((await http().get('/v1/master-data').set('X-Device-Key', tablet.key)).status).toBe(
        200,
      );
      const res = await http().get('/v1/master-data').set('X-Device-Key', unseen.key);
      expectProblem(res, 503, 'DB_UNAVAILABLE');
      expect(res.headers['retry-after']).toBe('30');
      const login = await http().post('/v1/auth/login').set('X-Device-Key', tablet.key).send(LOGIN);
      expectProblem(login, 503, 'DB_UNAVAILABLE');
    } finally {
      await testDb.allowConnections(true);
    }
  });
});
