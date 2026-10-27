import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DefectId } from '@m100/shared';
import { adminUrl, createTestDatabase, testEnvValue, type TestDatabase } from '../testing/database';
import { jpeg } from '../testing/photo-store-contract';
import {
  FINDINGS,
  insertFinding,
  insertPhoto,
  insertSubmission,
  seedMasterData,
  submissionRow,
} from '../testing/schema-fixtures';
import { DUMP_FILE, MANIFEST_FILE, photoMirror, runBackup, type BackupOptions } from './backup';
import { pgToolPath } from './pg-tools';
import { restoreBackup } from './restore';

const pgBin = testEnvValue('PG_BIN');
const hasPgTools = ['pg_dump', 'pg_restore'].every(
  (tool) =>
    spawnSync(pgToolPath(tool as 'pg_dump', pgBin), ['--version'], { windowsHide: true }).status ===
    0,
);
// Like the S3 tests: skipped, not failed, on a machine without the PostgreSQL client tools.
const describeIfPgTools = hasPgTools ? describe : describe.skip;

describeIfPgTools('backup and restore (doc 03 §7.6)', () => {
  jest.setTimeout(120_000);

  let db: TestDatabase;
  let work: string;
  let root: string;
  let photoDir: string;
  let backupDir: string;
  let clock: number;

  beforeAll(async () => {
    db = await createTestDatabase({ migrated: true });
    await db.as('m100_migrate', seedMasterData, { commit: true });
    work = await mkdtemp(join(tmpdir(), 'm100-backup-'));
    root = join(work, 'install');
    photoDir = join(root, 'photos');
    backupDir = join(work, 'backup');
    await mkdir(join(root, 'secrets'), { recursive: true });
    await writeFile(join(root, '.env'), 'TZ=Asia/Jakarta\n');
    await writeFile(join(root, 'secrets', 'jwt.key'), randomBytes(32));
    clock = Date.parse('2026-10-27T01:00:00+07:00');
  });
  afterAll(async () => {
    await db?.drop();
    if (work) await rm(work, { recursive: true, force: true });
  });

  /** A stored submission with photo rows and photo files for `defects`; returns the photo keys. */
  async function submissionWithPhotos(defects: DefectId[]): Promise<string[]> {
    const keys = await db.as(
      'm100_migrate',
      async (c) => {
        const id = await insertSubmission(c, submissionRow());
        for (const f of FINDINGS) await insertFinding(c, id, f);
        for (const d of defects) await insertPhoto(c, id, d);
        return defects.map((d) => `submissions/2026/10/${id}/${d}.jpg`);
      },
      { commit: true },
    );
    for (const key of keys) {
      const file = join(photoDir, ...key.split('/'));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, jpeg(key));
    }
    return keys;
  }

  function backup(overrides: Partial<BackupOptions> = {}) {
    const at = clock;
    clock += 60_000;
    return runBackup({
      databaseUrl: db.url('m100_migrate'),
      backupDir,
      kind: 'daily',
      root,
      photoDir,
      release: '2026.10.27-test',
      pgBin,
      now: () => new Date(at),
      ...overrides,
    });
  }

  const scratchName = () => `m100_test_restore_${process.pid}_${randomBytes(3).toString('hex')}`;

  async function databaseExists(name: string): Promise<boolean> {
    const { rowCount } = await db.client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      name,
    ]);
    return rowCount === 1;
  }

  it('dumps the database, the install folder and the photos; a restore matches the manifest', async () => {
    await submissionWithPhotos(['D001', 'D003']);
    await submissionWithPhotos([]);

    const result = await backup();
    expect(result.folder).toBe(join(backupDir, 'daily', '2026-10-27_010000'));
    expect(result.manifest).toMatchObject({
      kind: 'daily',
      release: '2026.10.27-test',
      database: db.name,
      submissions: 2,
      submissionPhotos: 2,
      photos: 'mirrored',
      config: ['.env', 'secrets'],
    });
    expect(existsSync(join(result.folder, DUMP_FILE))).toBe(true);
    expect(existsSync(join(result.folder, MANIFEST_FILE))).toBe(true);
    expect(existsSync(join(result.folder, 'config', 'secrets', 'jwt.key'))).toBe(true);
    expect(await readdir(join(backupDir, 'daily'))).toEqual(['2026-10-27_010000']);

    const scratch = scratchName();
    const report = await restoreBackup({
      from: result.folder,
      adminUrl: adminUrl().href,
      database: scratch,
      pgBin,
    });
    expect(report).toMatchObject({
      ok: true,
      submissions: 2,
      submissionPhotos: 2,
      missingPhotos: [],
      badPhotos: [],
      photosChecked: 2,
      dropped: true,
    });
    expect(await databaseExists(scratch)).toBe(false);
  });

  it('restores with grants and the immutability trigger intact', async () => {
    const result = await backup();
    const scratch = scratchName();
    await restoreBackup({
      from: result.folder,
      adminUrl: adminUrl().href,
      database: scratch,
      keep: true,
      pgBin,
    });
    try {
      const url = new URL(adminUrl().href);
      url.pathname = `/${scratch}`;
      const { Client } = await import('pg');
      const client = new Client({ connectionString: url.href });
      await client.connect();
      try {
        const { rows } = await client.query<{ owner: string; app: boolean }>(
          `SELECT tableowner AS owner, has_table_privilege('m100_app', 'submissions', 'INSERT') AS app
             FROM pg_tables WHERE tablename = 'submissions'`,
        );
        expect(rows[0]).toEqual({ owner: 'm100_migrate', app: true });
        await expect(client.query('DELETE FROM submissions')).rejects.toThrow(/immutable/);
      } finally {
        await client.end();
      }
    } finally {
      await db.client.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }
  });

  it('adds new photos to the mirror; a photo missing from it fails the restore check', async () => {
    const [newKey] = await submissionWithPhotos(['D002']);
    const result = await backup();
    expect(result.manifest).toMatchObject({ submissions: 3, submissionPhotos: 3 });
    const mirrored = join(photoMirror(backupDir), ...newKey!.split('/'));
    expect(existsSync(mirrored)).toBe(true);

    await rm(mirrored);
    const report = await restoreBackup({
      from: result.folder,
      adminUrl: adminUrl().href,
      database: scratchName(),
      pgBin,
    });
    expect(report.ok).toBe(false);
    expect(report.missingPhotos).toEqual([newKey]);
  });

  it('refuses a damaged dump and an existing database name', async () => {
    const result = await backup();
    await expect(
      restoreBackup({ from: result.folder, adminUrl: adminUrl().href, database: db.name, pgBin }),
    ).rejects.toThrow(/already exists/);

    await writeFile(join(result.folder, DUMP_FILE), 'not a dump');
    await expect(
      restoreBackup({
        from: result.folder,
        adminUrl: adminUrl().href,
        database: scratchName(),
        pgBin,
      }),
    ).rejects.toThrow(/does not match the SHA-256/);
  });

  it('keeps the last 5 pre-upgrade backups and leaves no partial folder on failure', async () => {
    const dir = join(backupDir, 'pre-upgrade');
    const older = [
      '2026-10-01_010000',
      '2026-10-02_010000',
      '2026-10-03_010000',
      '2026-10-04_010000',
      '2026-10-05_010000',
    ];
    for (const name of older) await mkdir(join(dir, name), { recursive: true });

    const result = await backup({ kind: 'pre-upgrade' });
    expect(result.deleted).toEqual(['2026-10-01_010000']);
    expect(await readdir(dir)).toHaveLength(5);

    await expect(
      backup({
        kind: 'pre-upgrade',
        databaseUrl: db.url('m100_migrate').replace(db.name, 'm100_test_missing'),
      }),
    ).rejects.toThrow();
    expect((await readdir(dir)).filter((n) => n.endsWith('.partial'))).toEqual([]);
  });

  it('backs up a server that has no photo folder yet', async () => {
    const result = await backup({ photoDir: join(work, 'no-photos-yet') });
    expect(result.manifest.photos).toBe('mirrored');
    expect(existsSync(join(result.folder, DUMP_FILE))).toBe(true);
  });

  it('leaves no scratch database behind, also after a failed restore', async () => {
    const { rows } = await db.client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname LIKE $1',
      [`m100_test_restore_${process.pid}_%`],
    );
    expect(rows).toEqual([]);
  });
});
