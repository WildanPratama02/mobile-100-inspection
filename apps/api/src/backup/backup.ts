/**
 * One backup (doc 03 §7.6): a `pg_dump -Fc` of the database, the install folder's `.env`, `secrets/` and Caddy data,
 * and the photo folder copied into `<backupDir>/photos`. Photos never change once stored and their keys are unique
 * (doc 02 §7), so that one copy only ever gains files and holds every photo of every kept dump.
 *
 * The dump and the counts in `manifest.json` come from the same database snapshot, so a restore can be checked
 * against them exactly. A backup is written to `<name>.partial` and renamed when complete; only complete ones count
 * for retention and restore.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Client } from 'pg';
import { runPgTool } from './pg-tools';
import {
  backupName,
  backupsToDelete,
  NIGHTLY_RETENTION,
  PRE_UPGRADE_RETENTION,
  type RetentionRule,
} from './retention';

export type BackupKind = 'daily' | 'pre-upgrade';

export const RETENTION: Record<BackupKind, RetentionRule> = {
  daily: NIGHTLY_RETENTION,
  'pre-upgrade': PRE_UPGRADE_RETENTION,
};

export const DUMP_FILE = 'm100.dump';
export const MANIFEST_FILE = 'manifest.json';
/** Copied from the install folder when present (doc 03 §7.6). */
export const CONFIG_ENTRIES = ['.env', 'secrets', 'caddy-data'] as const;

export interface BackupOptions {
  /** The database owner (`MIGRATE_DATABASE_URL`): it can read every table. */
  databaseUrl: string;
  backupDir: string;
  kind: BackupKind;
  /** The install folder that holds `.env`, `secrets/` and `caddy-data/`. */
  root: string;
  /** The photo folder of a `disk` store; `undefined` for S3, whose bucket is not copied here. */
  photoDir?: string;
  /** The release that took the backup (`VERSION`), for the manifest. */
  release?: string;
  pgBin?: string;
  now?: () => Date;
}

export interface BackupManifest {
  format: 1;
  kind: BackupKind;
  name: string;
  startedAt: string;
  finishedAt: string;
  release: string | null;
  database: string;
  submissions: number;
  submissionPhotos: number;
  dump: { file: string; bytes: number; sha256: string };
  /** `mirrored`: copied into `<backupDir>/photos`; `not-copied`: an S3 store, to be synced on its own. */
  photos: 'mirrored' | 'not-copied';
  config: string[];
}

export interface BackupResult {
  folder: string;
  manifest: BackupManifest;
  /** Older backups removed by retention. */
  deleted: string[];
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** The mirror of the photo folder next to the backups. */
export function photoMirror(backupDir: string): string {
  return join(backupDir, 'photos');
}

export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  const now = options.now ?? (() => new Date());
  const started = now();
  const name = backupName(started);
  const kindDir = join(options.backupDir, options.kind);
  const partial = join(kindDir, `${name}.partial`);
  const folder = join(kindDir, name);
  if (existsSync(folder)) throw new Error(`Backup ${folder} already exists`);
  await mkdir(partial, { recursive: true });

  try {
    const dumpPath = join(partial, DUMP_FILE);
    const counts = await dumpAtOneSnapshot(options, dumpPath);

    const config: string[] = [];
    for (const entry of CONFIG_ENTRIES) {
      const source = join(options.root, entry);
      if (!existsSync(source)) continue;
      await cp(source, join(partial, 'config', entry), { recursive: true });
      config.push(entry);
    }

    // No folder yet means no photo yet (the store creates it with the first one).
    if (options.photoDir && existsSync(options.photoDir)) {
      // Missing files only; a file already in the mirror is the same photo (immutable keys). Skips the store's
      // `.name.tmp` files of a write in progress.
      await cp(options.photoDir, photoMirror(options.backupDir), {
        recursive: true,
        force: false,
        errorOnExist: false,
        filter: (source) => !basename(source).startsWith('.'),
      });
    }

    const manifest: BackupManifest = {
      format: 1,
      kind: options.kind,
      name,
      startedAt: started.toISOString(),
      finishedAt: now().toISOString(),
      release: options.release ?? null,
      database: counts.database,
      submissions: counts.submissions,
      submissionPhotos: counts.submissionPhotos,
      dump: {
        file: DUMP_FILE,
        bytes: (await stat(dumpPath)).size,
        sha256: await fileSha256(dumpPath),
      },
      photos: options.photoDir ? 'mirrored' : 'not-copied',
      config,
    };
    await writeFile(join(partial, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(partial, folder);

    const deleted = await applyRetention(kindDir, RETENTION[options.kind], now());
    return { folder, manifest, deleted };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Counts the submissions in a `REPEATABLE READ` transaction, exports its snapshot and has `pg_dump` dump exactly
 * that snapshot, so a submission arriving meanwhile is in neither or both.
 */
async function dumpAtOneSnapshot(
  options: BackupOptions,
  dumpPath: string,
): Promise<{ database: string; submissions: number; submissionPhotos: number }> {
  const client = new Client({
    connectionString: options.databaseUrl,
    application_name: 'm100 backup',
  });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await client.query<{
      snapshot: string;
      database: string;
      submissions: string;
      photos: string;
    }>(
      `SELECT pg_export_snapshot() AS snapshot, current_database() AS database,
              (SELECT count(*) FROM submissions) AS submissions,
              (SELECT count(*) FROM submission_photos) AS photos`,
    );
    const row = rows[0]!;
    await runPgTool(
      'pg_dump',
      options.databaseUrl,
      ['--format=custom', `--file=${dumpPath}`, `--snapshot=${row.snapshot}`],
      options.pgBin,
    );
    await client.query('COMMIT');
    return {
      database: row.database,
      submissions: Number(row.submissions),
      submissionPhotos: Number(row.photos),
    };
  } finally {
    await client.end();
  }
}

/** Removes the backups `rule` does not keep, and `.partial` leftovers of a run that died over a day ago. */
async function applyRetention(kindDir: string, rule: RetentionRule, now: Date): Promise<string[]> {
  const names = await readdir(kindDir);
  const deleted = backupsToDelete(names, rule);
  for (const name of deleted) await rm(join(kindDir, name), { recursive: true, force: true });
  for (const name of names.filter((n) => n.endsWith('.partial'))) {
    const info = await stat(join(kindDir, name));
    if (now.getTime() - info.mtimeMs > 86_400_000) {
      await rm(join(kindDir, name), { recursive: true, force: true });
    }
  }
  return deleted;
}
