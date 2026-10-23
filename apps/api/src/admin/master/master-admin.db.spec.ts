import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../app';
import { AppModule } from '../../app.module';
import { Database } from '../../db/database';
import { importMaster, pgImportRepositories } from '../../import/import-master';
import { parseMaster } from '../../import/parse-master';
import { createTestDatabase, type TestDatabase } from '../../testing/database';
import { registerDevice, type TestDevice } from '../../testing/devices';
import { testConfig } from '../../testing/env';
import { fixtureTables } from '../../testing/master-fixtures';
import { expectMatchesSpec, expectProblem } from '../../testing/openapi';
import { insertSubmission, submissionRow } from '../../testing/schema-fixtures';
import { createAdmin, pgAdminAccountRepositories } from '../admin-accounts';

let testDb: TestDatabase;
let db: Database;
let photoDir: string;
let app: NestExpressApplication;
let cookie: string;
let tablet: TestDevice;

const PASSWORD = 'a-strong-password-1';
const XRW = { 'X-Requested-With': 'm100-admin' };

/** The body of an answer, typed for the test. */
const bodyOf = <T>(res: request.Response) => res.body as T;
const idOf = (res: request.Response) => bodyOf<{ id: number }>(res).id;

/** Each test sends from its own address and tablet, so no rate budget (60 a minute) is shared between tests. */
let counter = 0;
let ip = '';
beforeEach(async () => {
  ++counter;
  ip = `10.2.${Math.floor(counter / 250)}.${counter % 250}`;
  tablet = await registerDevice(testDb.client);
});

/** Requests of the signed-in admin; changes carry `X-Requested-With`. */
const admin = () => {
  const agent = request(app.getHttpServer());
  const from = (r: request.Test) => r.set('X-Forwarded-For', ip).set('Cookie', cookie);
  return {
    get: (url: string) => from(agent.get(url)),
    post: (url: string) => from(agent.post(url)).set(XRW),
    patch: (url: string) => from(agent.patch(url)).set(XRW),
  };
};

/** The tablet's view of the master data. */
async function masterData() {
  const res = await request(app.getHttpServer())
    .get('/v1/master-data')
    .set('X-Device-Key', tablet.key);
  expect(res.status).toBe(200);
  return {
    etag: res.headers.etag as string,
    body: res.body as {
      users: { username: string; level: string }[];
      factories: { factory: string; cells: string[] }[];
      defects: { id: string }[];
      map: { mapId: string; defectId: string }[];
    },
  };
}

async function masterVersion(): Promise<number> {
  const { rows } = await testDb.client.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'master_version'`,
  );
  return Number(rows[0]!.value);
}

async function auditRows(entity: string, entityId: string) {
  const { rows } = await testDb.client.query<{
    actor: string;
    action: string;
    details: { old?: Record<string, unknown>; new?: Record<string, unknown> };
  }>(
    `SELECT actor, action, details FROM audit_log WHERE entity = $1 AND entity_id = $2 ORDER BY id`,
    [entity, entityId],
  );
  return rows;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: true });
  db = new Database(testDb.pool('m100_app'));
  await importMaster(db, pgImportRepositories(db), parseMaster(await fixtureTables()), {
    dryRun: false,
  });
  await createAdmin(db, pgAdminAccountRepositories(db), {
    username: 'qip.digital',
    password: PASSWORD,
    actor: 'script:admin:create',
  });
  photoDir = mkdtempSync(join(tmpdir(), 'm100-master-admin-'));
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
    .set('X-Forwarded-For', '10.2.255.1')
    .send({ username: 'qip.digital', password: PASSWORD });
  expect(login.status).toBe(204);
  cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!;
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
  rmSync(photoDir, { recursive: true, force: true });
});

describe('admin master data: access (doc 04 §2, §8)', () => {
  it('refuses a request without the admin cookie, a change without X-Requested-With, and a tablet token', async () => {
    const agent = request(app.getHttpServer());
    expectProblem(
      await agent.get('/v1/admin/psi-users').set('X-Forwarded-For', ip),
      401,
      'ADMIN_AUTH_REQUIRED',
    );
    expectProblem(
      await agent
        .post('/v1/admin/factories')
        .set('X-Forwarded-For', ip)
        .set('Cookie', cookie)
        .send({ name: 'F 8' }),
      401,
      'ADMIN_AUTH_REQUIRED',
    );
    const login = await agent
      .post('/v1/auth/login')
      .set('X-Device-Key', tablet.key)
      .send({ username: 'TEST ANDI', level: 'PSI lv.1', factory: 'F 1', cell: 'F1-1' });
    expect(login.status).toBe(200);
    expectProblem(
      await agent
        .get('/v1/admin/psi-users')
        .set('X-Device-Key', tablet.key)
        .set('Authorization', `Bearer ${bodyOf<{ token: string }>(login).token}`),
      401,
      'ADMIN_AUTH_REQUIRED',
    );
    expect((await agent.get('/v1/admin/factories').set('Cookie', 'm100_admin=x.y.z')).status).toBe(
      401,
    );
    const { rows } = await testDb.client.query(`SELECT 1 FROM factories WHERE name = 'F 8'`);
    expect(rows).toEqual([]);
  });
});

describe('PSI users (doc 05 §20.4, A2)', () => {
  it('adds a user once per (name, level); a duplicate is 409 CONFLICT; each add is audited and bumps the version', async () => {
    const before = await masterData();
    const version = await masterVersion();

    const res = await admin()
      .post('/v1/admin/psi-users')
      .send({ username: 'TEST FAJAR', level: 'PSI lv.2' });
    expectMatchesSpec(res, 'post', '/admin/psi-users');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(Number) as number,
      username: 'TEST FAJAR',
      level: 'PSI lv.2',
      active: true,
    });
    expect(await masterVersion()).toBe(version + 1);
    const after = await masterData();
    expect(after.etag).not.toBe(before.etag);
    expect(after.body.users).toContainEqual({ username: 'TEST FAJAR', level: 'PSI lv.2' });
    expect(await auditRows('psi_users', String(idOf(res)))).toEqual([
      {
        actor: 'admin:qip.digital',
        action: 'create',
        details: { new: { username: 'TEST FAJAR', level: 'PSI lv.2', active: true } },
      },
    ]);

    const duplicate = await admin()
      .post('/v1/admin/psi-users')
      .send({ username: 'TEST FAJAR', level: 'PSI lv.2' });
    expectMatchesSpec(duplicate, 'post', '/admin/psi-users');
    expect(expectProblem(duplicate, 409, 'CONFLICT').detail).toBe('Nama dan level ini sudah ada.');
    // The same name at the other level is another row (doc 02 §3.1).
    const other = await admin()
      .post('/v1/admin/psi-users')
      .send({ username: 'TEST FAJAR', level: 'PSI lv.1' });
    expect(other.status).toBe(201);
    expect(await masterVersion()).toBe(version + 2);
  });

  it('renames, changes level and deactivates; a change to nothing new writes nothing', async () => {
    const created = await admin()
      .post('/v1/admin/psi-users')
      .send({ username: 'TEST GITA', level: 'PSI lv.1' });
    const id = String(idOf(created));

    const renamed = await admin()
      .patch(`/v1/admin/psi-users/${id}`)
      .send({ username: 'TEST GITA P', level: 'PSI lv.1' });
    expectMatchesSpec(renamed, 'patch', '/admin/psi-users/{id}');
    expect(renamed.body).toMatchObject({
      username: 'TEST GITA P',
      level: 'PSI lv.1',
      active: true,
    });

    const version = await masterVersion();
    const same = await admin().patch(`/v1/admin/psi-users/${id}`).send({ username: 'TEST GITA P' });
    expect(same.status).toBe(200);
    expect(await masterVersion()).toBe(version);

    const before = await masterData();
    const off = await admin().patch(`/v1/admin/psi-users/${id}`).send({ active: false });
    expect(bodyOf<{ active: boolean }>(off).active).toBe(false);
    const after = await masterData();
    expect(after.etag).not.toBe(before.etag);
    expect(after.body.users.map((u) => u.username)).not.toContain('TEST GITA P');
    // The admin list still shows it (doc 02 §3: inactive rows are hidden but kept).
    const list = await admin().get('/v1/admin/psi-users');
    expectMatchesSpec(list, 'get', '/admin/psi-users');
    expect(list.body).toContainEqual({
      id: Number(id),
      username: 'TEST GITA P',
      level: 'PSI lv.1',
      active: false,
    });

    expect((await auditRows('psi_users', id)).map((a) => [a.action, a.details])).toEqual([
      ['create', { new: { username: 'TEST GITA', level: 'PSI lv.1', active: true } }],
      ['update', { old: { username: 'TEST GITA' }, new: { username: 'TEST GITA P' } }],
      ['deactivate', { old: { active: true }, new: { active: false } }],
    ]);
  });

  it('refuses a rename onto an existing (name, level), an unknown id and a bad body', async () => {
    const created = await admin()
      .post('/v1/admin/psi-users')
      .send({ username: 'TEST HADI', level: 'PSI lv.2' });
    const res = await admin()
      .patch(`/v1/admin/psi-users/${idOf(created)}`)
      .send({ username: 'TEST BUDI' });
    expectMatchesSpec(res, 'patch', '/admin/psi-users/{id}');
    expectProblem(res, 409, 'CONFLICT');

    expectProblem(
      await admin().patch('/v1/admin/psi-users/999999').send({ active: false }),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await admin().patch('/v1/admin/psi-users/abc').send({ active: false }),
      404,
      'NOT_FOUND',
    );
    for (const body of [
      {},
      { username: ' TEST X', level: 'PSI lv.1' },
      { username: 'TEST X', level: 'CFA' },
      { username: 'TEST X', level: 'PSI lv.1', nik: '123' },
    ]) {
      const bad = await admin().post('/v1/admin/psi-users').send(body);
      expectMatchesSpec(bad, 'post', '/admin/psi-users');
      expectProblem(bad, 422, 'VALIDATION_FAILED');
    }
  });
});

describe('factories and cells (A3)', () => {
  it('adds a factory and its cells; duplicates are 409; an unknown factory is 422; cells filter by factory', async () => {
    const factory = await admin().post('/v1/admin/factories').send({ name: 'F 7' });
    expectMatchesSpec(factory, 'post', '/admin/factories');
    expect(factory.status).toBe(201);
    expectProblem(await admin().post('/v1/admin/factories').send({ name: 'F 7' }), 409, 'CONFLICT');

    const cell = await admin()
      .post('/v1/admin/cells')
      .send({ factoryId: idOf(factory), code: 'F7-01' });
    expectMatchesSpec(cell, 'post', '/admin/cells');
    expect(cell.body).toEqual({
      id: expect.any(Number) as number,
      factoryId: idOf(factory),
      factory: 'F 7',
      code: 'F7-01',
      active: true,
    });
    expectProblem(
      await admin()
        .post('/v1/admin/cells')
        .send({ factoryId: idOf(factory), code: 'F7-01' }),
      409,
      'CONFLICT',
    );
    const unknown = await admin()
      .post('/v1/admin/cells')
      .send({ factoryId: 999999, code: 'F9-01' });
    expect(expectProblem(unknown, 422, 'VALIDATION_FAILED').errors).toEqual([
      { path: 'factoryId', code: 'NOT_FOUND', message: 'Factory tidak ditemukan.' },
    ]);

    const cells = await admin().get(`/v1/admin/cells?factoryId=${idOf(factory)}`);
    expectMatchesSpec(cells, 'get', '/admin/cells');
    expect(bodyOf<{ code: string }[]>(cells).map((c) => c.code)).toEqual(['F7-01']);
    expect((await masterData()).body.factories).toContainEqual({
      factory: 'F 7',
      cells: ['F7-01'],
    });

    const off = await admin()
      .patch(`/v1/admin/cells/${idOf(cell)}`)
      .send({ active: false });
    expectMatchesSpec(off, 'patch', '/admin/cells/{id}');
    expect((await masterData()).body.factories).toContainEqual({ factory: 'F 7', cells: [] });
    const factoryOff = await admin()
      .patch(`/v1/admin/factories/${idOf(factory)}`)
      .send({ active: false });
    expectMatchesSpec(factoryOff, 'patch', '/admin/factories/{id}');
    expect((await masterData()).body.factories.map((f) => f.factory)).not.toContain('F 7');
    expect((await auditRows('cells', String(idOf(cell)))).map((a) => a.action)).toEqual([
      'create',
      'deactivate',
    ]);
  });
});

describe('POs (A4)', () => {
  it('adds, edits and deactivates one PO; a deactivated PO leaves the tablet search but stays on old submissions (AC-14.2)', async () => {
    const created = await admin().post('/v1/admin/pos').send({
      po: '0907770001',
      article: 'ZZ0001',
      model: 'TEST\u00a0MODEL',
      destination: 'JAPAN',
      orderQty: 1500,
      podd: '2026-11-01',
      crd: null,
    });
    expectMatchesSpec(created, 'post', '/admin/pos');
    expect(created.body).toEqual({
      po: '0907770001',
      article: 'ZZ0001',
      model: 'TEST\u00a0MODEL',
      destination: 'JAPAN',
      orderQty: 1500,
      podd: '2026-11-01',
      crd: null,
      finished: null,
      active: true,
      source: 'admin',
    });
    expectProblem(
      await admin()
        .post('/v1/admin/pos')
        .send({
          ...bodyOf<object>(created),
          active: undefined,
          finished: undefined,
          source: undefined,
        }),
      409,
      'CONFLICT',
    );

    // A PO from the import becomes the admin's once an admin changes a value.
    const edited = await admin()
      .patch('/v1/admin/pos/0902028839')
      .send({ orderQty: 10003, crd: '2026-02-01' });
    expectMatchesSpec(edited, 'patch', '/admin/pos/{po}');
    expect(edited.body).toMatchObject({ orderQty: 10003, crd: '2026-02-01', source: 'admin' });
    expect((await auditRows('pos', '0902028839'))[0]?.details).toEqual({
      old: { orderQty: expect.any(Number) as number, crd: '2026-01-12' },
      new: { orderQty: 10003, crd: '2026-02-01' },
    });

    // A submission written while the PO was active keeps its snapshot.
    const submissionId = await insertSubmission(
      testDb.client,
      submissionRow({
        device_id: tablet.id,
        po: '0907770001',
        article: 'ZZ0001',
        model: 'TEST\u00a0MODEL',
        order_qty: 1500,
        username: 'TEST ANDI',
        level: 'PSI lv.1',
        factory: 'F 1',
        cell: 'F1-1',
        partial_no: null,
        partial_qty: null,
        qty_rework: 0,
        qty_bgrade_inspections: 0,
        qty_no_defect: 5,
        qty_inspection: 5,
        qty_a_grade: 5,
        qty_b_grade: 0,
        qty_defect: 0,
        rft: '1.00000',
        defect_rate: '0.00000',
        photo_count: 0,
      }),
    );
    const off = await admin().patch('/v1/admin/pos/0907770001').send({ active: false });
    expect(off.body).toMatchObject({ active: false, source: 'admin' });

    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('X-Device-Key', tablet.key)
      .send({ username: 'TEST ANDI', level: 'PSI lv.1', factory: 'F 1', cell: 'F1-1' });
    const tabletGet = (url: string) =>
      request(app.getHttpServer())
        .get(url)
        .set('X-Device-Key', tablet.key)
        .set('Authorization', `Bearer ${bodyOf<{ token: string }>(login).token}`);
    expectProblem(await tabletGet('/v1/pos/0907770001'), 404, 'PO_NOT_FOUND');
    expect(bodyOf<{ items: unknown[] }>(await tabletGet('/v1/pos?q=7770001')).items).toEqual([]);

    const search = await admin().get('/v1/admin/pos?q=7770001');
    expectMatchesSpec(search, 'get', '/admin/pos');
    expect(search.body).toEqual([expect.objectContaining({ po: '0907770001', active: false })]);
    const { rows } = await testDb.client.query(
      `SELECT po, model, username FROM v_submissions WHERE id = $1`,
      [submissionId],
    );
    expect(rows).toEqual([{ po: '0907770001', model: 'TEST\u00a0MODEL', username: 'TEST ANDI' }]);
  });

  it('checks the search text and the PO fields', async () => {
    expectProblem(await admin().get('/v1/admin/pos?q=%2077%20'), 422, 'VALIDATION_FAILED');
    expectProblem(await admin().get('/v1/admin/pos'), 422, 'VALIDATION_FAILED');
    for (const body of [{ orderQty: 0 }, { podd: '2026-02-30' }, { po: 'X' }, { finished: true }]) {
      expectProblem(
        await admin().patch('/v1/admin/pos/0902028839').send(body),
        422,
        'VALIDATION_FAILED',
      );
    }
    expectProblem(
      await admin().patch('/v1/admin/pos/NO-SUCH-PO').send({ active: false }),
      404,
      'NOT_FOUND',
    );
  });
});

describe('defects and the area map (A5)', () => {
  it('lists the 98 defects and toggles one; its map rows leave /master-data until it is reactivated', async () => {
    const list = await admin().get('/v1/admin/defects');
    expectMatchesSpec(list, 'get', '/admin/defects');
    expect(list.body).toHaveLength(98);

    const off = await admin().patch('/v1/admin/defects/D035').send({ active: false });
    expectMatchesSpec(off, 'patch', '/admin/defects/{id}');
    expect(off.body).toMatchObject({ id: 'D035', active: false });
    let master = (await masterData()).body;
    expect(master.defects.map((d) => d.id)).not.toContain('D035');
    expect(master.map.some((m) => m.defectId === 'D035')).toBe(false);

    const on = await admin().patch('/v1/admin/defects/D035').send({ active: true });
    expect(bodyOf<{ active: boolean }>(on).active).toBe(true);
    master = (await masterData()).body;
    expect(master.defects.map((d) => d.id)).toContain('D035');
    expect((await auditRows('defects', 'D035')).map((a) => a.action)).toEqual([
      'deactivate',
      'reactivate',
    ]);

    // Names are not editable in release 1 (doc 05 §20.5).
    expectProblem(
      await admin().patch('/v1/admin/defects/D035').send({ name: 'X' }),
      422,
      'VALIDATION_FAILED',
    );
    expectProblem(
      await admin().patch('/v1/admin/defects/D999').send({ active: false }),
      404,
      'NOT_FOUND',
    );
  });

  it('shows areas, sub-areas, families and every map row, and deactivates one map row', async () => {
    const res = await admin().get('/v1/admin/area-map');
    expectMatchesSpec(res, 'get', '/admin/area-map');
    expect(bodyOf<{ areas: unknown[] }>(res).areas).toHaveLength(12);
    const row = bodyOf<{ rows: { id: string }[] }>(res).rows[0]!;
    const before = await masterData();
    expect(before.body.map.map((m) => m.mapId)).toContain(row.id);

    const off = await admin().patch(`/v1/admin/area-map/${row.id}`).send({ active: false });
    expectMatchesSpec(off, 'patch', '/admin/area-map/{id}');
    const after = await masterData();
    expect(after.etag).not.toBe(before.etag);
    expect(after.body.map.map((m) => m.mapId)).not.toContain(row.id);
    expectProblem(
      await admin().patch('/v1/admin/area-map/MAP-NONE').send({ active: false }),
      404,
      'NOT_FOUND',
    );
  });
});
