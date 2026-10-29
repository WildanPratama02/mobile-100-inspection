import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import { listMigrations, migrate } from '../db/migrate';
import { adminUrl, createTestDatabase, testEnvValue, type TestDatabase } from '../testing/database';
import { jpeg } from '../testing/photo-store-contract';
import {
  FINDINGS,
  insertFinding,
  insertSubmission,
  seedMasterData,
  submissionRow,
} from '../testing/schema-fixtures';
import { runBackup, photoMirror } from './backup';
import { pgToolPath } from './pg-tools';
import { restoreBackup } from './restore';

const pgBin = testEnvValue('PG_BIN');
const hasTools = ['pg_dump', 'pg_restore'].every(
  (tool) =>
    spawnSync(pgToolPath(tool as 'pg_dump', pgBin), ['--version'], { windowsHide: true }).status ===
    0,
);

(hasTools ? describe : describe.skip)('Phase 5 coordinated recovery rehearsal', () => {
  jest.setTimeout(120_000);
  let db: TestDatabase;
  let work: string;
  const restored: string[] = [];
  beforeAll(async () => {
    db = await createTestDatabase();
    work = await mkdtemp(join(tmpdir(), 'm100-phase5-recovery-'));
  });
  afterAll(async () => {
    const admin = new Client({ connectionString: adminUrl().href });
    await admin.connect();
    try {
      for (const name of restored)
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
    await db?.drop();
    if (work) await rm(work, { recursive: true, force: true });
  });
  async function snapshot(client: Client) {
    const rows: Record<string, unknown[]> = {};
    for (const table of ['submissions', 'submission_findings', 'submission_photos', 'audit_log']) {
      rows[table] = (
        await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)
      ).rows;
    }
    return rows;
  }
  async function restore(from: string) {
    const name = `m100_test_phase5_${randomBytes(5).toString('hex')}`;
    restored.push(name);
    const report = await restoreBackup({
      from,
      adminUrl: adminUrl().href,
      database: name,
      keep: true,
      pgBin,
    });
    expect(report.ok).toBe(true);
    const url = adminUrl();
    url.pathname = '/' + name;
    const client = new Client({ connectionString: url.href });
    await client.connect();
    return client;
  }
  it('verifies a pre-0006 backup, preserves the incident snapshot, and recovers both formats and original audit rows', async () => {
    await db.client.query('SET ROLE m100_migrate');
    await migrate(
      db.client,
      listMigrations().filter((m) => !m.version.startsWith('0006_')),
    );
    await seedMasterData(db.client);
    const legacy = submissionRow({ photo_count: 0 });
    delete legacy.counting_rule;
    await insertSubmission(db.client, legacy);
    await db.client.query(
      "INSERT INTO audit_log(actor, action, entity) VALUES ('system','PRE_MIGRATION','recovery-rehearsal')",
    );
    const before = await snapshot(db.client);
    const options = {
      databaseUrl: db.url('m100_migrate'),
      backupDir: join(work, 'backups'),
      root: work,
      photoDir: join(work, 'photos'),
      pgBin,
    };
    await mkdir(options.photoDir);
    const pre = await runBackup({ ...options, kind: 'pre-upgrade', release: 'pre-0006' });
    const preRestored = await restore(pre.folder);
    try {
      expect(await snapshot(preRestored)).toEqual(before);
      await preRestored.query('SET ROLE m100_migrate');
      await migrate(preRestored);
      const migrated = (
        await preRestored.query('SELECT counting_rule,qty_a_grade FROM submissions')
      ).rows;
      expect(migrated).toEqual([{ counting_rule: 'ADR-008', qty_a_grade: 18 }]);
    } finally {
      await preRestored.end();
    }

    await migrate(db.client);
    const manualId = await insertSubmission(
      db.client,
      submissionRow({
        counting_rule: 'ADR-019',
        qty_no_defect: null,
        qty_a_grade: 19,
        rft: '0.63333',
        photo_count: 1,
      }),
    );
    for (const finding of FINDINGS) await insertFinding(db.client, manualId, finding);
    await db.client.query(
      "INSERT INTO audit_log(actor,action,entity,entity_id,details) VALUES ('script:rehearsal','POST_BACKUP','submission',$1,$2)",
      [manualId, { source: 'incident' }],
    );
    const key = `submissions/2026/10/${manualId}/D001.jpg`;
    const photo = jpeg(key);
    await db.client.query(
      'INSERT INTO submission_photos (submission_id,defect_id,object_key,sha256,size_bytes) VALUES ($1,$2,$3,$4,$5)',
      [manualId, 'D001', key, createHash('sha256').update(photo).digest(), photo.length],
    );
    await insertSubmission(db.client, submissionRow({ photo_count: 0 }));
    await mkdir(dirname(join(options.photoDir, key)), { recursive: true });
    await writeFile(join(options.photoDir, key), photo);
    const incidentRows = await snapshot(db.client);
    const incident = await runBackup({ ...options, kind: 'daily', release: 'phase5-recovery' });
    const recovered = await restore(incident.folder);
    try {
      // Full incident restore avoids rewriting accepted records through API replay.
      expect(await snapshot(recovered)).toEqual(incidentRows);
      expect(
        (
          await recovered.query(
            'SELECT counting_rule,qty_a_grade FROM submissions ORDER BY display_no',
          )
        ).rows,
      ).toEqual([
        { counting_rule: 'ADR-008', qty_a_grade: 18 },
        { counting_rule: 'ADR-019', qty_a_grade: 19 },
        { counting_rule: 'ADR-008', qty_a_grade: 18 },
      ]);
      const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
      expect(digest(await readFile(join(photoMirror(options.backupDir), key)))).toBe(digest(photo));
      await recovered.query('SET ROLE m100_app');
      await expect(recovered.query("UPDATE audit_log SET action='CHANGED'")).rejects.toMatchObject({
        code: '42501',
      });
      await expect(recovered.query('DELETE FROM submissions')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await recovered.end();
    }
  });
});
