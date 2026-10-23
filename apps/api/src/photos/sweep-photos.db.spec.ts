import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { DefectId } from '@m100/shared';
import { Database } from '../db/database';
import { PgAuditLogRepository } from '../repositories/audit-log.repository';
import { PgSubmissionRepository } from '../repositories/submission.repository';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { jpeg, listAll, sha256 } from '../testing/photo-store-contract';
import { describeIfS3, testBuckets, type TestBuckets } from '../testing/s3';
import {
  FINDINGS,
  insertFinding,
  insertPhoto,
  insertSubmission,
  seedMasterData,
  submissionRow,
} from '../testing/schema-fixtures';
import { DiskPhotoStore } from './disk-photo-store';
import type { PhotoStore } from './photo-store';
import { ORPHAN_AGE_MS, SWEEP_ACTOR, sweepPhotos } from './sweep-photos';

let db: TestDatabase;
let app: Database;

beforeAll(async () => {
  db = await createTestDatabase({ migrated: true });
  await db.as('m100_migrate', seedMasterData, { commit: true });
  app = new Database(db.pool('m100_app'));
});
afterAll(async () => {
  await db?.drop();
});

/** A stored submission with photo rows for `defects`; returns their keys (as `insertPhoto` makes them). */
async function submissionWithPhotos(defects: DefectId[]): Promise<string[]> {
  return db.as(
    'm100_migrate',
    async (c) => {
      const id = await insertSubmission(c, submissionRow());
      for (const f of FINDINGS) await insertFinding(c, id, f);
      for (const d of defects) await insertPhoto(c, id, d);
      return defects.map((d) => `submissions/2026/10/${id}/${d}.jpg`);
    },
    { commit: true },
  );
}

async function put(store: PhotoStore, keys: string[]): Promise<void> {
  for (const key of keys) {
    const bytes = jpeg(key);
    await store.put(key, bytes, sha256(bytes));
  }
}

const orphanKey = (d: DefectId = 'D001') => `submissions/2026/10/${randomUUID()}/${d}.jpg`;

async function sweepRows(): Promise<{ details: Record<string, unknown> }[]> {
  const { rows } = await db.client.query<{ details: Record<string, unknown> }>(
    'SELECT details FROM audit_log WHERE actor = $1 ORDER BY id',
    [SWEEP_ACTOR],
  );
  return rows;
}

function deps(store: PhotoStore) {
  return {
    store,
    submissions: new PgSubmissionRepository(app),
    auditLog: new PgAuditLogRepository(app),
  };
}

/** The sweep's rules on any store. Times come from the store's own clock, so nothing is back-dated. */
function describeSweep(name: string, make: () => Promise<PhotoStore>): void {
  describe(`sweep-photos on ${name} (doc 02 §6.2)`, () => {
    it('removes only old objects without a submission_photos row; a dry run first only reports them', async () => {
      const store = await make();
      const used = await submissionWithPhotos(['D001', 'D002']);
      const oldOrphans = [orphanKey('D003'), orphanKey('D004'), '_probe/left-over.jpg'];
      await put(store, [...used, ...oldOrphans]);
      // S3 keeps whole seconds: everything above is then before `boundary`, everything below at or after it.
      await delay(1_100);
      const boundary = new Date(Math.floor(Date.now() / 1000) * 1000);
      const young = [orphanKey('D005')];
      await put(store, young);
      const now = new Date(boundary.getTime() + ORPHAN_AGE_MS);
      const auditBefore = (await sweepRows()).length;

      const dry = await sweepPhotos(deps(store), { now, dryRun: true });
      expect(dry).toEqual({ dryRun: true, scanned: 6, old: 5, orphans: [...oldOrphans].sort() });
      expect(await listAll(store)).toHaveLength(6);
      expect(await sweepRows()).toHaveLength(auditBefore);

      const real = await sweepPhotos(deps(store), { now });
      expect(real).toEqual({ ...dry, dryRun: false });
      expect((await listAll(store)).map((p) => p.key)).toEqual([...used, ...young].sort());
      const rows = await sweepRows();
      expect(rows).toHaveLength(auditBefore + 1);
      expect(rows.at(-1)!.details).toEqual({
        scanned: 6,
        old: 5,
        deleted: 3,
        keys: [...oldOrphans].sort(),
      });

      // A second run finds nothing more to remove.
      expect((await sweepPhotos(deps(store), { now })).orphans).toEqual([]);
    });

    it('never removes an object outside submissions/ and _probe/', async () => {
      const store = await make();
      await put(store, ['other/kept.jpg', 'kept.jpg']);
      const now = new Date(Date.now() + 2 * ORPHAN_AGE_MS);
      expect(await sweepPhotos(deps(store), { now, dryRun: true })).toMatchObject({
        scanned: 0,
        orphans: [],
      });
      await sweepPhotos(deps(store), { now });
      expect(await listAll(store)).toHaveLength(2);
    });
  });
}

describe('on a folder', () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'm100-sweep-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true, maxRetries: 5 });
  });

  describeSweep('DiskPhotoStore', () => Promise.resolve(new DiskPhotoStore(base)));

  it('keeps an object exactly 24 hours old and removes one a millisecond older', async () => {
    const store = new DiskPhotoStore(base);
    const now = new Date('2026-10-22T03:00:00.000Z');
    const exactly = orphanKey('D001');
    const older = orphanKey('D002');
    await put(store, [exactly, older]);
    const at = (key: string, ms: number) =>
      utimes(join(base, ...key.split('/')), new Date(ms), new Date(ms));
    await at(exactly, now.getTime() - ORPHAN_AGE_MS);
    await at(older, now.getTime() - ORPHAN_AGE_MS - 1);

    expect((await sweepPhotos(deps(store), { now })).orphans).toEqual([older]);
    expect((await listAll(store)).map((p) => p.key)).toEqual([exactly]);
  });

  it('records what it deleted when the database fails part way, and passes the error on', async () => {
    const store = new DiskPhotoStore(base);
    const orphans = [orphanKey('D001'), orphanKey('D002')];
    await put(store, orphans);
    const appended: unknown[] = [];
    const failure = new Error('connection lost');
    const report = sweepPhotos(
      {
        store,
        submissions: { photoKeysInUse: () => Promise.reject(failure) },
        auditLog: {
          append: (entry) => {
            appended.push(entry);
            return Promise.reject(new Error('audit also down'));
          },
          list: () => Promise.resolve([]),
          search: () => Promise.resolve({ total: 0, items: [] }),
        },
      },
      { now: new Date(Date.now() + 2 * ORPHAN_AGE_MS) },
    );
    await expect(report).rejects.toBe(failure);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      actor: SWEEP_ACTOR,
      details: { deleted: 0, keys: [], failed: 'connection lost' },
    });
    expect(await listAll(store)).toHaveLength(2);
  });
});

describeIfS3('on S3', () => {
  let buckets: TestBuckets;
  beforeAll(() => {
    buckets = testBuckets();
  });
  afterAll(async () => {
    await buckets?.drop();
  });

  describeSweep('S3PhotoStore', () => buckets.store());
});
