import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Database } from '../db/database';
import { importMaster, pgImportRepositories } from '../import/import-master';
import { parseMaster } from '../import/parse-master';
import { DiskPhotoStore } from '../photos/disk-photo-store';
import type { PhotoStore } from '../photos/photo-store';
import { PgReadinessRepository } from '../repositories/readiness.repository';
import { PgSettingsRepository } from '../repositories/settings.repository';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { testConfig } from '../testing/env';
import { fixtureTables } from '../testing/master-fixtures';
import { RETRY_MS, ReadinessService, type SystemStatus } from './readiness.service';

let testDb: TestDatabase;
let db: Database;
let photoDir: string;

function service(photos: PhotoStore = new DiskPhotoStore(photoDir)): ReadinessService {
  return new ReadinessService(
    testConfig(),
    new PgReadinessRepository(db),
    new PgSettingsRepository(db),
    photos,
  );
}

function failing(status: SystemStatus): Record<string, string | undefined> {
  return Object.fromEntries(status.checks.filter((c) => !c.ok).map((c) => [c.id, c.message]));
}

beforeAll(async () => {
  Logger.overrideLogger(false);
  testDb = await createTestDatabase({ migrated: true });
  db = new Database(testDb.pool('m100_app'));
  photoDir = mkdtempSync(join(tmpdir(), 'm100-readiness-'));
});

afterAll(async () => {
  await testDb.allowConnections(true).catch(() => undefined);
  await testDb?.drop();
  rmSync(photoDir, { recursive: true, force: true });
});

describe('readiness checks (doc 02 §10)', () => {
  it('fails MASTER_DATA before the import, with the reason, and retries after 30 s', async () => {
    const readiness = service();
    const status = await readiness.check();
    readiness.onApplicationShutdown();
    expect(status.submitEnabled).toBe(false);
    expect(failing(status)).toEqual({
      MASTER_DATA:
        'no active PSI users; no active cells; 0 defects, expected 98; 0 areas, expected 12; no active area map rows',
    });
    expect(readiness.nextDelayMs()).toBe(RETRY_MS);
  });

  it('passes every check after the import; the next run is in MASTER_CHECK_SECONDS', async () => {
    await importMaster(db, pgImportRepositories(db), parseMaster(await fixtureTables()), {
      dryRun: false,
    });
    const readiness = service();
    const status = await readiness.check();
    readiness.onApplicationShutdown();
    expect(status).toMatchObject({ submitEnabled: true, masterDataVersion: '1' });
    expect(status.checks.map((c) => [c.id, c.ok])).toEqual([
      ['DB', true],
      ['MASTER_DATA', true],
      ['PHOTO_STORE', true],
      ['SUBMIT_ENABLED', true],
    ]);
    expect(readiness.nextDelayMs()).toBe(testConfig().masterCheckSeconds * 1000);
  });

  it('fails SUBMIT_ENABLED while settings.submit_enabled is false', async () => {
    await testDb.client.query(`UPDATE settings SET value = 'false' WHERE key = 'submit_enabled'`);
    try {
      const readiness = service();
      const status = await readiness.check();
      readiness.onApplicationShutdown();
      expect(failing(status)).toEqual({ SUBMIT_ENABLED: 'settings.submit_enabled is false' });
    } finally {
      await testDb.client.query(`UPDATE settings SET value = 'true' WHERE key = 'submit_enabled'`);
    }
  });

  it('fails PHOTO_STORE when the probe fails, without showing the error to the tablet', async () => {
    class BrokenStore extends DiskPhotoStore {
      override probe(): Promise<void> {
        return Promise.reject(new Error('EACCES: D:\\photos'));
      }
    }
    const readiness = service(new BrokenStore(photoDir));
    const status = await readiness.check();
    readiness.onApplicationShutdown();
    expect(failing(status)).toEqual({ PHOTO_STORE: 'Photo store not writable' });
  });

  it('a stopped database disables Submit PO with DB failing; the run after 30 s re-enables it', async () => {
    const readiness = service();
    expect((await readiness.check()).submitEnabled).toBe(true);

    await testDb.allowConnections(false);
    const down = await readiness.check();
    expect(down.submitEnabled).toBe(false);
    expect(failing(down)).toMatchObject({ DB: 'Database not reachable' });
    expect(readiness.nextDelayMs()).toBe(RETRY_MS);

    await testDb.allowConnections(true);
    const up = await readiness.check();
    readiness.onApplicationShutdown();
    expect(up.submitEnabled).toBe(true);
    expect(failing(up)).toEqual({});
  });
});
