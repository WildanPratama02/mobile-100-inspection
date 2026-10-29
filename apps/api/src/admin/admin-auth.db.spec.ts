import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../app';
import { AppModule } from '../app.module';
import { TokenSigner } from '../auth/jwt';
import { TabletTokens } from '../auth/tablet-token';
import { Database } from '../db/database';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { registerDevice, type TestDevice } from '../testing/devices';
import { testConfig, testJwtKey } from '../testing/env';
import { expectMatchesSpec, expectProblem } from '../testing/openapi';
import { tamperSignature } from '../testing/tamper';
import { createAdmin, deactivateAdmin, pgAdminAccountRepositories } from './admin-accounts';
import { LOGIN_LOCK } from './admin-auth.service';
import { AdminTokens, SESSION_LIFETIME_SECONDS } from './admin-session';

let testDb: TestDatabase;
let db: Database;
let photoDir: string;
let app: NestExpressApplication;
let tablet: TestDevice;

const PASSWORD = 'a-strong-password-1';
const signer = () => new TokenSigner(testJwtKey());
const XRW = { 'X-Requested-With': 'm100-admin' };

/** Every test sends from its own address, so the per-address rate limit of one test does not touch another. */
let ipCounter = 0;
let ip = '';
beforeEach(() => {
  ++ipCounter;
  ip = `10.1.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
});
const http = () => {
  const agent = request(app.getHttpServer());
  return {
    get: (url: string) => agent.get(url).set('X-Forwarded-For', ip),
    post: (url: string) => agent.post(url).set('X-Forwarded-For', ip),
  };
};

function login(username: string, password: string) {
  return http().post('/v1/admin/auth/login').set(XRW).send({ username, password });
}

/** The `m100_admin=…` pair of a login answer, ready for a `Cookie` header. */
function cookieOf(res: request.Response): string {
  const header = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0] ?? '';
  return header.split(';')[0]!;
}

async function signIn(username: string, password = PASSWORD): Promise<string> {
  const res = await login(username, password);
  expect(res.status).toBe(204);
  return cookieOf(res);
}

async function lastAudit(entityId: number) {
  const { rows } = await testDb.client.query<{
    actor: string;
    action: string;
    entity: string;
    entity_id: string;
    details: Record<string, unknown> | null;
  }>(
    `SELECT actor, action, entity, entity_id, details FROM audit_log WHERE entity = 'admins' AND entity_id = $1
      ORDER BY id DESC LIMIT 1`,
    [String(entityId)],
  );
  return rows[0];
}

async function adminId(username: string): Promise<number> {
  return (await pgAdminAccountRepositories(db).admins.findByUsername(username))!.id;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: true });
  db = new Database(testDb.pool('m100_app'));
  photoDir = mkdtempSync(join(tmpdir(), 'm100-admin-auth-'));
  const actor = 'script:admin:create' as const;
  for (const username of ['qip.digital', 'locky', 'changer', 'leaver', 'second']) {
    await createAdmin(db, pgAdminAccountRepositories(db), { username, password: PASSWORD, actor });
  }
  tablet = await registerDevice(testDb.client, 'Tablet A');
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

describe('POST /admin/auth/login (doc 04 §2, §8)', () => {
  it('sets an 8-hour HttpOnly Secure SameSite=Strict cookie for /v1/admin, needs no device key, and audits the login', async () => {
    const res = await login('qip.digital', PASSWORD);
    expectMatchesSpec(res, 'post', '/admin/auth/login');
    expect(res.status).toBe(204);
    const [cookie] = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(cookie).toMatch(/^m100_admin=[\w-]+\.[\w-]+\.[\w-]+;/);
    const attributes = cookie!.split(';').map((part) => part.trim());
    expect(attributes).toEqual(
      expect.arrayContaining([
        `Max-Age=${SESSION_LIFETIME_SECONDS}`,
        'Path=/v1/admin',
        'HttpOnly',
        'Secure',
        'SameSite=Strict',
      ]),
    );
    expect(SESSION_LIFETIME_SECONDS).toBe(8 * 60 * 60);
    const token = cookieOf(res).slice('m100_admin='.length);
    const verified = signer().verify(token, { audience: 'admin', now: new Date() });
    expect(verified.ok && verified.claims.exp - verified.claims.iat).toBe(8 * 60 * 60);

    const id = await adminId('qip.digital');
    expect(await lastAudit(id)).toMatchObject({
      actor: 'admin:qip.digital',
      action: 'login',
      entity: 'admins',
    });
  });

  it('answers a wrong password, an unknown username and an inactive account alike', async () => {
    await deactivateAdmin(db, pgAdminAccountRepositories(db), {
      id: await adminId('leaver'),
      actor: 'script:admin:create',
    });
    for (const [username, password] of [
      ['qip.digital', 'wrong-password-0'],
      ['nobody', PASSWORD],
      ['leaver', PASSWORD],
    ] as const) {
      const res = await login(username, password);
      expectMatchesSpec(res, 'post', '/admin/auth/login');
      const body = expectProblem(res, 401, 'ADMIN_LOGIN_FAILED');
      expect(body.detail).toBe('Username atau password salah.');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('refuses a login without X-Requested-With', async () => {
    const res = await http()
      .post('/v1/admin/auth/login')
      .send({ username: 'qip.digital', password: PASSWORD });
    expectMatchesSpec(res, 'post', '/admin/auth/login');
    expectProblem(res, 401, 'ADMIN_AUTH_REQUIRED');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a malformed body and unknown fields', async () => {
    for (const body of [
      { username: 'qip.digital' },
      { username: 'qip.digital', password: PASSWORD, x: 1 },
    ]) {
      const res = await http().post('/v1/admin/auth/login').set(XRW).send(body);
      expectMatchesSpec(res, 'post', '/admin/auth/login');
      expectProblem(res, 422, 'VALIDATION_FAILED');
    }
  });

  it(`locks the account for 10 minutes after ${LOGIN_LOCK.failures} wrong passwords (ADMIN_LOCKED), also for the right one`, async () => {
    const id = await adminId('locky');
    for (let i = 1; i < LOGIN_LOCK.failures; i++) {
      expectProblem(await login('locky', `wrong-password-${i}`), 401, 'ADMIN_LOGIN_FAILED');
    }
    const started = Date.now();
    const fifth = await login('locky', 'wrong-password-5');
    expectMatchesSpec(fifth, 'post', '/admin/auth/login');
    const body = expectProblem(fifth, 423, 'ADMIN_LOCKED');
    expect(body.detail).toBe('Akun dikunci 10 menit karena terlalu banyak percobaan.');
    expect(Number(fifth.headers['retry-after'])).toBeGreaterThan(590);
    expect(Number(fifth.headers['retry-after'])).toBeLessThanOrEqual(600);

    const { rows } = await testDb.client.query<{ locked_until: Date }>(
      'SELECT locked_until FROM admins WHERE id = $1',
      [id],
    );
    const lockMs = rows[0]!.locked_until.getTime() - started;
    expect(lockMs).toBeGreaterThan(LOGIN_LOCK.ms - 5_000);
    expect(lockMs).toBeLessThanOrEqual(LOGIN_LOCK.ms + 5_000);
    expect(LOGIN_LOCK.ms).toBe(10 * 60_000);
    expect(await lastAudit(id)).toMatchObject({
      actor: 'system',
      action: 'lock',
      details: { username: 'locky', failures: 5 },
    });

    const right = await login('locky', PASSWORD);
    expectProblem(right, 423, 'ADMIN_LOCKED');
    expect(right.headers['set-cookie']).toBeUndefined();

    // Ten minutes later (the lock moved into the past): the right password works, with a fresh set of attempts.
    await testDb.client.query(
      `UPDATE admins SET locked_until = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    expect((await login('locky', PASSWORD)).status).toBe(204);
    expectProblem(await login('locky', 'wrong-password-6'), 401, 'ADMIN_LOGIN_FAILED');
  });

  it('answers 503 DB_UNAVAILABLE while the database is down', async () => {
    await testDb.allowConnections(false);
    try {
      const res = await login('qip.digital', PASSWORD);
      expectProblem(res, 503, 'DB_UNAVAILABLE');
    } finally {
      await testDb.allowConnections(true);
    }
  });
});

describe('the admin session', () => {
  it('GET /admin/me answers the signed-in admin', async () => {
    const cookie = await signIn('qip.digital');
    const res = await http().get('/v1/admin/me').set('Cookie', cookie);
    expectMatchesSpec(res, 'get', '/admin/me');
    expect(res.status).toBe(200);
    const body = res.body as { username: string; lastLoginAt: string };
    expect(Object.keys(body).sort()).toEqual(['lastLoginAt', 'username']);
    expect(body.username).toBe('qip.digital');
    expect(body.lastLoginAt).toMatch(/\+07:00$/);
  });

  it('refuses a missing, tampered, expired or tablet-audience cookie', async () => {
    const id = await adminId('qip.digital');
    const tokens = new AdminTokens(signer());
    const valid = (await signIn('qip.digital')).slice('m100_admin='.length);
    const expired = tokens.issue(
      { sub: 'qip.digital', aid: id },
      new Date(Date.now() - (SESSION_LIFETIME_SECONDS + 60) * 1000),
    ).token;
    const tabletAudience = signer().sign(
      { sub: 'qip.digital', aid: id },
      { audience: 'tablet', now: new Date(), lifetimeSeconds: 3600 },
    ).token;
    for (const cookie of [
      undefined,
      `m100_admin=${tamperSignature(valid)}`,
      `m100_admin=${expired}`,
      `m100_admin=${tabletAudience}`,
      `other=${valid}`,
    ]) {
      let req = http().get('/v1/admin/me');
      if (cookie) req = req.set('Cookie', cookie);
      const res = await req;
      expectMatchesSpec(res, 'get', '/admin/me');
      expectProblem(res, 401, 'ADMIN_AUTH_REQUIRED');
    }
  });

  it('ends at once when the admin is deactivated', async () => {
    const cookie = await signIn('second');
    expect((await http().get('/v1/admin/me').set('Cookie', cookie)).status).toBe(200);
    await deactivateAdmin(db, pgAdminAccountRepositories(db), {
      id: await adminId('second'),
      actor: 'admin:qip.digital',
    });
    expectProblem(
      await http().get('/v1/admin/me').set('Cookie', cookie),
      401,
      'ADMIN_AUTH_REQUIRED',
    );
  });

  it('POST /admin/auth/logout clears the cookie; it needs the session and the header', async () => {
    const cookie = await signIn('qip.digital');
    const noHeader = await http().post('/v1/admin/auth/logout').set('Cookie', cookie);
    expectMatchesSpec(noHeader, 'post', '/admin/auth/logout');
    expectProblem(noHeader, 401, 'ADMIN_AUTH_REQUIRED');

    const res = await http().post('/v1/admin/auth/logout').set(XRW).set('Cookie', cookie);
    expectMatchesSpec(res, 'post', '/admin/auth/logout');
    expect(res.status).toBe(204);
    const [cleared] = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(cleared).toMatch(
      /^m100_admin=; Max-Age=0; Path=\/v1\/admin; HttpOnly; Secure; SameSite=Strict$/,
    );
  });
});

describe('tablet and admin credentials never cross (doc 04 §2)', () => {
  const tabletToken = () =>
    new TabletTokens(signer()).issue({
      sub: 'TEST BUDI',
      lvl: 'PSI lv.2',
      fac: 'F 1',
      cel: 'F1-1',
      dev: tablet.id,
    }).token;

  it('a tablet token (with its device key) is refused on admin endpoints', async () => {
    for (const send of [
      () => http().get('/v1/admin/me'),
      () => http().post('/v1/admin/auth/logout').set(XRW),
      () =>
        http().post('/v1/admin/me/password').set(XRW).send({
          currentPassword: PASSWORD,
          newPassword: 'another-password-2',
        }),
    ]) {
      const res = await send()
        .set('X-Device-Key', tablet.key)
        .set('Authorization', `Bearer ${tabletToken()}`);
      expectProblem(res, 401, 'ADMIN_AUTH_REQUIRED');
    }
    // The tablet token as the cookie value fails too (wrong audience).
    const res = await http().get('/v1/admin/me').set('Cookie', `m100_admin=${tabletToken()}`);
    expectProblem(res, 401, 'ADMIN_AUTH_REQUIRED');
  });

  it('an admin session is refused on tablet endpoints, as cookie or as bearer token', async () => {
    const cookie = await signIn('qip.digital');
    const adminToken = cookie.slice('m100_admin='.length);

    const asCookie = await http()
      .get('/v1/pos?q=1234')
      .set('X-Device-Key', tablet.key)
      .set('Cookie', cookie);
    expectMatchesSpec(asCookie, 'get', '/pos');
    expectProblem(asCookie, 401, 'TOKEN_INVALID');

    const asBearer = await http()
      .get('/v1/pos?q=1234')
      .set('X-Device-Key', tablet.key)
      .set('Authorization', `Bearer ${adminToken}`);
    expectMatchesSpec(asBearer, 'get', '/pos');
    expectProblem(asBearer, 401, 'TOKEN_INVALID');

    const withoutKey = await http().get('/v1/master-data').set('Cookie', cookie);
    expectProblem(withoutKey, 401, 'DEVICE_KEY_INVALID');
  });
});

describe('POST /admin/me/password', () => {
  let cookie: string;
  let id: number;
  const change = (body: object, headers: Record<string, string> = XRW) =>
    http().post('/v1/admin/me/password').set(headers).set('Cookie', cookie).send(body);

  beforeAll(async () => {
    id = await adminId('changer');
  });
  beforeEach(async () => {
    cookie = await signIn('changer');
  });

  it('is refused without X-Requested-With and changes nothing', async () => {
    const before = await testDb.client.query('SELECT password_hash FROM admins WHERE id = $1', [
      id,
    ]);
    const res = await change({ currentPassword: PASSWORD, newPassword: 'another-password-2' }, {});
    expectMatchesSpec(res, 'post', '/admin/me/password');
    expectProblem(res, 401, 'ADMIN_AUTH_REQUIRED');
    const after = await testDb.client.query('SELECT password_hash FROM admins WHERE id = $1', [id]);
    expect(after.rows).toEqual(before.rows);
  });

  it('wants a new password of at least 10 characters and the right current one', async () => {
    const weak = await change({ currentPassword: PASSWORD, newPassword: 'admin123' });
    expectMatchesSpec(weak, 'post', '/admin/me/password');
    expect(expectProblem(weak, 422, 'VALIDATION_FAILED').errors).toEqual([
      { path: 'newPassword', code: 'PASSWORD_TOO_SHORT', message: 'Password minimal 10 karakter.' },
    ]);

    const wrong = await change({
      currentPassword: 'not-my-password',
      newPassword: 'another-password-2',
    });
    expectMatchesSpec(wrong, 'post', '/admin/me/password');
    expect(expectProblem(wrong, 422, 'VALIDATION_FAILED').errors).toEqual([
      { path: 'currentPassword', code: 'PASSWORD_WRONG', message: 'Password lama salah.' },
    ]);
    const { rows } = await testDb.client.query<{ failed_logins: number }>(
      'SELECT failed_logins FROM admins WHERE id = $1',
      [id],
    );
    expect(rows[0]!.failed_logins).toBe(1);
  });

  it('changes the password and audits it with admin, target and summary', async () => {
    const res = await change({ currentPassword: PASSWORD, newPassword: 'another-password-2' });
    expectMatchesSpec(res, 'post', '/admin/me/password');
    expect(res.status).toBe(204);
    expect(await lastAudit(id)).toEqual({
      actor: 'admin:changer',
      action: 'change_password',
      entity: 'admins',
      entity_id: String(id),
      details: { username: 'changer' },
    });
    const { rows } = await testDb.client.query<{ details: unknown }>(
      `SELECT details FROM audit_log`,
    );
    expect(JSON.stringify(rows)).not.toMatch(/another-password-2|a-strong-password-1|argon2/);
    expectProblem(await login('changer', PASSWORD), 401, 'ADMIN_LOGIN_FAILED');
    expect((await login('changer', 'another-password-2')).status).toBe(204);
  });
});
