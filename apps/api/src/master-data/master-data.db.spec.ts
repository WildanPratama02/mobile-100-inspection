import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../app';
import { AppModule } from '../app.module';
import { Database } from '../db/database';
import { importMaster, pgImportRepositories } from '../import/import-master';
import { parseMaster } from '../import/parse-master';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { testConfig } from '../testing/env';
import { fixtureTables } from '../testing/master-fixtures';
import { expectMatchesSpec, expectProblem } from '../testing/openapi';
import { ReadinessService } from './readiness.service';

let testDb: TestDatabase;
let photoDir: string;
const apps: NestExpressApplication[] = [];

async function startApp(): Promise<NestExpressApplication> {
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
  const app = configureApp(
    moduleRef.createNestApplication<NestExpressApplication>({ logger: false }),
  );
  await app.init();
  apps.push(app);
  return app;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: true });
  photoDir = mkdtempSync(join(tmpdir(), 'm100-master-data-'));
});

afterAll(async () => {
  await testDb.allowConnections(true).catch(() => undefined);
  for (const app of apps) await app.close();
  await testDb?.drop();
  rmSync(photoDir, { recursive: true, force: true });
});

describe('GET /v1/master-data (doc 04 §3.2)', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await startApp();
  });

  it('answers an empty document at version 0 before the import', async () => {
    const res = await http().get('/v1/master-data');
    expect(res.status).toBe(200);
    expectMatchesSpec(res, 'get', '/master-data');
    expect(res.headers.etag).toBe('"0"');
    expect(res.body).toMatchObject({
      version: '0',
      users: [],
      factories: [],
      defects: [],
      map: [],
    });
  });

  it('serves the imported active rows with ETag = master_version, as the spec says', async () => {
    const db = new Database(testDb.pool('m100_app'));
    await importMaster(db, pgImportRepositories(db), parseMaster(await fixtureTables()), {
      dryRun: false,
    });
    const res = await http().get('/v1/master-data');
    expect(res.status).toBe(200);
    expectMatchesSpec(res, 'get', '/master-data');
    expect(res.headers.etag).toBe('"1"');
    expect(res.headers['cache-control']).toBe('no-cache');
    const body = res.body as {
      version: string;
      fetchedAt: string;
      users: unknown[];
      factories: unknown[];
      areas: { id: string; subAreas: unknown[] }[];
      defects: { id: string; familyId: string }[];
      map: unknown[];
    };
    expect(body.version).toBe('1');
    expect(Date.parse(body.fetchedAt)).not.toBeNaN();
    expect(body.users).toHaveLength(5);
    expect(body.factories).toEqual([
      { factory: 'F 1', cells: ['F1-1', 'F1-2'] },
      { factory: 'F 2', cells: ['F2-1'] },
    ]);
    expect(body.areas).toHaveLength(12);
    expect(body.defects).toHaveLength(98);
    expect(body.defects[0]).toEqual({
      id: 'D001',
      name: expect.any(String) as string,
      classification: 'MINOR',
      familyId: 'F14',
    });
    expect(body.map).toHaveLength(437);
  });

  it.each(['"1"', 'W/"1"', '1', '"0", "1"', '*'])(
    'answers 304 without a body for If-None-Match %s',
    async (tag) => {
      const res = await http().get('/v1/master-data').set('If-None-Match', tag);
      expect(res.status).toBe(304);
      expect(res.headers.etag).toBe('"1"');
      expect(res.text).toBeFalsy();
    },
  );

  it('answers the full document for an older version', async () => {
    const res = await http().get('/v1/master-data').set('If-None-Match', '"0"');
    expect(res.status).toBe(200);
  });

  it('rebuilds when master_version changes; deactivated rows leave the document', async () => {
    await testDb.client.query(`UPDATE defects SET active = false WHERE id = 'D001'`);
    await testDb.client.query(`UPDATE psi_users SET active = false WHERE username = 'TEST ANDI'`);
    // Before the version changes, the cached copy is still current by definition.
    expect((await http().get('/v1/master-data')).body).toMatchObject({ version: '1' });
    await testDb.client.query(
      `UPDATE settings SET value = (value::bigint + 1)::text WHERE key = 'master_version'`,
    );
    const res = await http().get('/v1/master-data').set('If-None-Match', '"1"');
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"2"');
    const body = res.body as {
      users: { username: string }[];
      defects: { id: string }[];
      map: { defectId: string }[];
    };
    expect(body.users.map((u) => u.username)).not.toContain('TEST ANDI');
    expect(body.defects.map((d) => d.id)).not.toContain('D001');
    expect(body.map.map((m) => m.defectId)).not.toContain('D001');
  });

  it('serves the last good copy while the database is down, and flips the DB check', async () => {
    await testDb.allowConnections(false);
    try {
      const res = await http().get('/v1/master-data');
      expect(res.status).toBe(200);
      expect(res.headers.etag).toBe('"2"');
      expect(
        app
          .get(ReadinessService)
          .current()
          .checks.find((c) => c.id === 'DB')?.ok,
      ).toBe(false);

      // An API started while the database is down has no copy yet.
      const fresh = await startApp();
      const unavailable = await request(fresh.getHttpServer()).get('/v1/master-data');
      expectProblem(unavailable, 503, 'DB_UNAVAILABLE');
      expectMatchesSpec(unavailable, 'get', '/master-data');
      expect(unavailable.headers['retry-after']).toBe('30');
    } finally {
      await testDb.allowConnections(true);
    }
  });
});

describe('GET /v1/system/status (doc 04 §3, doc 02 §10)', () => {
  it('returns the readiness checks as the spec says', async () => {
    const app = await startApp();
    await app.get(ReadinessService).check();
    const res = await request(app.getHttpServer()).get('/v1/system/status');
    expect(res.status).toBe(200);
    expectMatchesSpec(res, 'get', '/system/status');
    expect(res.body).toMatchObject({ submitEnabled: true, masterDataVersion: '2' });
    expect((res.body as { checks: { id: string }[] }).checks.map((c) => c.id)).toEqual([
      'DB',
      'MASTER_DATA',
      'PHOTO_STORE',
      'SUBMIT_ENABLED',
    ]);
  });
});
