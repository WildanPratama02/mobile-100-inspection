import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../app';
import { AppModule } from '../../app.module';
import { Database } from '../../db/database';
import { createTestDatabase, type TestDatabase } from '../../testing/database';
import { registerDevice } from '../../testing/devices';
import { testConfig } from '../../testing/env';
import { expectMatchesSpec, expectProblem } from '../../testing/openapi';
import { createAdmin, pgAdminAccountRepositories } from '../admin-accounts';
import type { AdminAccount, AuditLogPage } from './accounts-admin.service';

let testDb: TestDatabase;
let photoDir: string;
let app: NestExpressApplication;
let cookie: string;
let selfId: number;

const PASSWORD = 'a-strong-password-1';
const XRW = { 'X-Requested-With': 'm100-admin' };

/** Changes only: every login is audited too. */
const CHANGES = `action <> 'login'`;

/** Each test sends from its own address, so the per-address limits of one test do not touch another. */
let counter = 0;
let ip = '';
beforeEach(() => {
  ++counter;
  ip = `10.4.${Math.floor(counter / 250)}.${counter % 250}`;
});

const http = () => request(app.getHttpServer());
const admin = () => {
  const from = (r: request.Test) => r.set('X-Forwarded-For', ip).set('Cookie', cookie);
  return {
    get: (url: string) => from(http().get(url)),
    post: (url: string) => from(http().post(url)).set(XRW),
    patch: (url: string) => from(http().patch(url)).set(XRW),
  };
};

function login(username: string, password: string) {
  return http()
    .post('/v1/admin/auth/login')
    .set(XRW)
    .set('X-Forwarded-For', ip)
    .send({ username, password });
}

async function signIn(username: string, password = PASSWORD): Promise<string> {
  const res = await login(username, password);
  expect(res.status).toBe(204);
  return ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]!.split(';')[0]!;
}

async function auditOf(id: number) {
  const { rows } = await testDb.client.query<{ actor: string; action: string; details: unknown }>(
    `SELECT actor, action, details FROM audit_log
      WHERE entity = 'admins' AND entity_id = $1 AND ${CHANGES} ORDER BY id`,
    [String(id)],
  );
  return rows;
}

async function create(username: string): Promise<AdminAccount> {
  const res = await admin().post('/v1/admin/admins').send({ username, password: PASSWORD });
  expect(res.status).toBe(201);
  return res.body as AdminAccount;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: true });
  const db = new Database(testDb.pool('m100_app'));
  selfId = (
    await createAdmin(db, pgAdminAccountRepositories(db), {
      username: 'qip.digital',
      password: PASSWORD,
      actor: 'script:admin:create',
    })
  ).id;
  photoDir = mkdtempSync(join(tmpdir(), 'm100-accounts-admin-'));
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
  ip = '10.4.255.1';
  cookie = await signIn('qip.digital');
});
afterAll(async () => {
  await app?.close();
  await testDb?.drop();
  if (photoDir) rmSync(photoDir, { recursive: true, force: true });
});

describe('/v1/admin/admins (doc 05 §20.6, A15)', () => {
  it('lists the accounts without any password hash', async () => {
    const res = await admin().get('/v1/admin/admins');
    expect(res.status).toBe(200);
    expectMatchesSpec(res, 'get', '/admin/admins');
    const [self] = res.body as AdminAccount[];
    expect(self).toMatchObject({
      id: selfId,
      username: 'qip.digital',
      active: true,
      lockedUntil: null,
    });
    expect(self!.lastLoginAt).toMatch(/\+07:00$/);
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|passwordHash/);
  });

  it('adds an admin who can sign in, and audits it without the password', async () => {
    const res = await admin()
      .post('/v1/admin/admins')
      .send({ username: 'ana', password: PASSWORD });
    expect(res.status).toBe(201);
    expectMatchesSpec(res, 'post', '/admin/admins');
    const added = res.body as AdminAccount;
    expect(added).toMatchObject({ username: 'ana', active: true, lastLoginAt: null });
    await signIn('ana');
    const audit = await auditOf(added.id);
    expect(audit).toEqual([
      { actor: 'admin:qip.digital', action: 'create', details: { username: 'ana' } },
    ]);
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
  });

  it('refuses a taken username (409), a short password and a bad username (422)', async () => {
    await create('budi');
    expectProblem(
      await admin().post('/v1/admin/admins').send({ username: 'budi', password: PASSWORD }),
      409,
      'CONFLICT',
    );
    const short = expectProblem(
      await admin().post('/v1/admin/admins').send({ username: 'citra', password: 'short' }),
      422,
      'VALIDATION_FAILED',
    );
    expect(short.errors).toEqual([
      expect.objectContaining({ path: 'password', code: 'PASSWORD_TOO_SHORT' }),
    ]);
    const spaced = expectProblem(
      await admin().post('/v1/admin/admins').send({ username: ' citra', password: PASSWORD }),
      422,
      'VALIDATION_FAILED',
    );
    expect(spaced.errors!.map((e) => e.path)).toEqual(['username']);
    expectProblem(
      await admin()
        .post('/v1/admin/admins')
        .send({ username: 'citra', password: PASSWORD, role: 'x' }),
      422,
      'VALIDATION_FAILED',
    );
  });

  it('refuses a change without X-Requested-With or without a session', async () => {
    const noHeader = await http()
      .post('/v1/admin/admins')
      .set('X-Forwarded-For', ip)
      .set('Cookie', cookie)
      .send({ username: 'dewi', password: PASSWORD });
    expectProblem(noHeader, 401, 'ADMIN_AUTH_REQUIRED');
    const tablet = await registerDevice(testDb.client);
    const fromTablet = await http()
      .get('/v1/admin/admins')
      .set('X-Forwarded-For', ip)
      .set('X-Device-Key', tablet.key);
    expectProblem(fromTablet, 401, 'ADMIN_AUTH_REQUIRED');
    const { rows } = await testDb.client.query(`SELECT 1 FROM admins WHERE username = 'dewi'`);
    expect(rows).toHaveLength(0);
  });

  it('resets a password: the old one stops working and a lock is cleared', async () => {
    const eko = await create('eko');
    await testDb.client.query(
      `UPDATE admins SET locked_until = now() + interval '10 minutes', failed_logins = 0 WHERE id = $1`,
      [eko.id],
    );
    const locked = (await admin().get('/v1/admin/admins')).body as AdminAccount[];
    expect(locked.find((a) => a.id === eko.id)!.lockedUntil).toMatch(/\+07:00$/);

    const res = await admin()
      .patch(`/v1/admin/admins/${eko.id}`)
      .send({ password: 'another-password-2' });
    expect(res.status).toBe(200);
    expectMatchesSpec(res, 'patch', '/admin/admins/{id}');
    expect((res.body as AdminAccount).lockedUntil).toBeNull();
    expect((await login('eko', PASSWORD)).status).toBe(401);
    await signIn('eko', 'another-password-2');
    expect((await auditOf(eko.id)).map((a) => a.action)).toEqual(['create', 'reset_password']);
  });

  it('deactivates another admin, which ends their session, and reactivates them', async () => {
    const fajar = await create('fajar');
    const theirCookie = await signIn('fajar');
    const off = await admin().patch(`/v1/admin/admins/${fajar.id}`).send({ active: false });
    expect(off.status).toBe(200);
    expect((off.body as AdminAccount).active).toBe(false);
    const after = await http()
      .get('/v1/admin/me')
      .set('X-Forwarded-For', ip)
      .set('Cookie', theirCookie);
    expectProblem(after, 401, 'ADMIN_AUTH_REQUIRED');
    expect((await login('fajar', PASSWORD)).status).toBe(401);

    const on = await admin().patch(`/v1/admin/admins/${fajar.id}`).send({ active: true });
    expect(on.status).toBe(200);
    expect((on.body as AdminAccount).active).toBe(true);
    await signIn('fajar');
    const audit = await auditOf(fajar.id);
    expect(audit.slice(1)).toEqual([
      {
        actor: 'admin:qip.digital',
        action: 'deactivate',
        details: { username: 'fajar', old: { active: true }, new: { active: false } },
      },
      {
        actor: 'admin:qip.digital',
        action: 'reactivate',
        details: { username: 'fajar', old: { active: false }, new: { active: true } },
      },
    ]);
    // Reactivating an active admin changes nothing and writes nothing.
    await admin().patch(`/v1/admin/admins/${fajar.id}`).send({ active: true });
    expect(await auditOf(fajar.id)).toHaveLength(3);
  });

  it('refuses deactivating yourself', async () => {
    const res = await admin().patch(`/v1/admin/admins/${selfId}`).send({ active: false });
    const body = expectProblem(res, 422, 'VALIDATION_FAILED');
    expect(body.errors).toEqual([expect.objectContaining({ path: 'active', code: 'SELF' })]);
  });

  it('takes one change per request and answers 404 for an unknown admin', async () => {
    expectProblem(
      await admin().patch(`/v1/admin/admins/${selfId}`).send({ active: true, password: PASSWORD }),
      422,
      'VALIDATION_FAILED',
    );
    expectProblem(
      await admin().patch(`/v1/admin/admins/${selfId}`).send({}),
      422,
      'VALIDATION_FAILED',
    );
    expectProblem(
      await admin().patch('/v1/admin/admins/99999').send({ active: false }),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await admin().patch('/v1/admin/admins/99999').send({ password: PASSWORD }),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await admin().patch('/v1/admin/admins/x').send({ active: false }),
      404,
      'NOT_FOUND',
    );
  });
});

describe('GET /v1/admin/audit-log (doc 05 §20.6, A16)', () => {
  it('reads the log newest first, filtered by actor and day', async () => {
    await create('gita');
    const res = await admin().get('/v1/admin/audit-log?actor=admin:qip.digital');
    expect(res.status).toBe(200);
    expectMatchesSpec(res, 'get', '/admin/audit-log');
    const page = res.body as AuditLogPage;
    expect(page).toMatchObject({ page: 1, pageSize: 50 });
    expect(page.items[0]).toMatchObject({
      actor: 'admin:qip.digital',
      action: 'create',
      entity: 'admins',
      details: { username: 'gita' },
    });
    expect(page.items.every((r) => r.actor === 'admin:qip.digital')).toBe(true);
    const ids = page.items.map((r) => Number(r.id));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(page.total).toBe(page.items.length);

    const scripts = (await admin().get('/v1/admin/audit-log?actor=script:admin:create'))
      .body as AuditLogPage;
    expect(scripts.items.map((r) => r.action)).toEqual(['create']);
    const past = (await admin().get('/v1/admin/audit-log?to=2020-01-01')).body as AuditLogPage;
    expect(past).toMatchObject({ total: 0, items: [] });
  });

  it('refuses a bad date or page with 422', async () => {
    expectProblem(
      await admin().get('/v1/admin/audit-log?from=2026-13-01'),
      422,
      'VALIDATION_FAILED',
    );
    expectProblem(await admin().get('/v1/admin/audit-log?page=0'), 422, 'VALIDATION_FAILED');
  });

  it('has no route that writes', async () => {
    for (const method of ['post', 'patch'] as const) {
      const res = await admin()[method]('/v1/admin/audit-log').send({});
      expect(res.status).toBe(404);
    }
  });
});
