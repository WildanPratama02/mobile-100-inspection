/**
 * Restores a backup of `runBackup` into a database and checks it (doc 03 §7.6): the dump's SHA-256, the submission
 * and photo-row counts against the manifest, every photo row's file in the photo mirror, and the JPEG signature of
 * a sample of them. The restore test restores into a scratch database and drops it afterwards; recovering a lost
 * server restores into `m100` with `replace`.
 */
import { existsSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import { ensureRole, ROLES } from '../db/bootstrap';
import { DUMP_FILE, fileSha256, MANIFEST_FILE, photoMirror, type BackupManifest } from './backup';
import { runPgTool } from './pg-tools';

const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export interface RestoreOptions {
  /** A backup folder, `<backupDir>/<kind>/<name>`. */
  from: string;
  /** A PostgreSQL superuser (`ADMIN_DATABASE_URL`): it creates the database and the roles. */
  adminUrl: string;
  database: string;
  /** Drop and recreate `database` when it exists (recovery). Without it an existing database is refused. */
  replace?: boolean;
  /** Keep the restored database after the checks. Implied by `replace`. */
  keep?: boolean;
  /** The photo mirror; default `<backupDir>/photos` next to `from`. */
  photosDir?: string;
  /** How many photos to open for the JPEG signature check. */
  samplePhotos?: number;
  pgBin?: string;
}

export interface RestoreReport {
  database: string;
  manifest: BackupManifest;
  submissions: number;
  submissionPhotos: number;
  /** Photo rows whose file is not in the mirror (empty when the backup did not copy photos). */
  missingPhotos: string[];
  /** Sampled files that do not start with the JPEG signature. */
  badPhotos: string[];
  photosChecked: number;
  ok: boolean;
  dropped: boolean;
}

export async function readManifest(from: string): Promise<BackupManifest> {
  const path = join(from, MANIFEST_FILE);
  if (!existsSync(path)) throw new Error(`${path} not found: not a finished backup folder`);
  return JSON.parse(await readFile(path, 'utf8')) as BackupManifest;
}

function databaseUrl(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.href;
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url, application_name: 'm100 backup:restore' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function restoreBackup(options: RestoreOptions): Promise<RestoreReport> {
  const { database } = options;
  if (!DATABASE_NAME.test(database)) throw new Error(`${database} is not a valid database name`);
  const manifest = await readManifest(options.from);
  const dumpPath = join(options.from, manifest.dump.file || DUMP_FILE);
  if ((await fileSha256(dumpPath)) !== manifest.dump.sha256) {
    throw new Error(`${dumpPath} does not match the SHA-256 in the manifest: the copy is damaged`);
  }

  await withClient(options.adminUrl, async (admin) => {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      database,
    ]);
    if (rowCount && !options.replace) {
      throw new Error(`Database ${database} already exists; choose another name`);
    }
    for (const role of Object.values(ROLES)) await ensureRole(admin, role);
    const name = admin.escapeIdentifier(database);
    if (rowCount) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.query(
      `CREATE DATABASE ${name} OWNER ${ROLES.migrate} ENCODING 'UTF8' TEMPLATE template0`,
    );
    await admin.query(`ALTER DATABASE ${name} SET timezone TO 'Asia/Jakarta'`);
  });

  const target = databaseUrl(options.adminUrl, database);
  let dropped = false;
  try {
    // Objects become the owner's again (`--role`), grants to m100_app and m100_report come from the dump.
    await runPgTool(
      'pg_restore',
      target,
      ['--no-owner', `--role=${ROLES.migrate}`, '--exit-on-error', dumpPath],
      options.pgBin,
    );

    const { counts, keys } = await withClient(target, async (client) => {
      const result = await client.query<{ submissions: string; photos: string }>(
        `SELECT (SELECT count(*) FROM submissions) AS submissions,
                (SELECT count(*) FROM submission_photos) AS photos`,
      );
      const photoRows = await client.query<{ object_key: string }>(
        'SELECT object_key FROM submission_photos ORDER BY id',
      );
      return { counts: result.rows[0]!, keys: photoRows.rows.map((r) => r.object_key) };
    });

    const mirror = options.photosDir ?? photoMirror(dirname(dirname(options.from)));
    const checked = manifest.photos === 'mirrored' ? keys : [];
    const missingPhotos = checked.filter((key) => !existsSync(join(mirror, ...key.split('/'))));
    const present = checked.filter((key) => !missingPhotos.includes(key));
    const sample = spread(present, options.samplePhotos ?? 5);
    const badPhotos: string[] = [];
    for (const key of sample) {
      if (!(await startsWithJpegSignature(join(mirror, ...key.split('/'))))) badPhotos.push(key);
    }

    const submissions = Number(counts.submissions);
    const submissionPhotos = Number(counts.photos);
    const ok =
      submissions === manifest.submissions &&
      submissionPhotos === manifest.submissionPhotos &&
      missingPhotos.length === 0 &&
      badPhotos.length === 0;

    if (!options.keep && !options.replace) {
      await dropDatabase(options.adminUrl, database);
      dropped = true;
    }
    return {
      database,
      manifest,
      submissions,
      submissionPhotos,
      missingPhotos,
      badPhotos,
      photosChecked: sample.length,
      ok,
      dropped,
    };
  } catch (error) {
    if (!options.keep && !options.replace && !dropped) {
      await dropDatabase(options.adminUrl, database).catch(() => undefined);
    }
    throw error;
  }
}

async function dropDatabase(adminUrl: string, database: string): Promise<void> {
  await withClient(adminUrl, (admin) =>
    admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)} WITH (FORCE)`),
  );
}

/** Up to `count` items spread evenly over `items`, first and last included. */
export function spread<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  if (count <= 0) return [];
  if (count === 1) return [items[0]!];
  return Array.from(
    { length: count },
    (_, i) => items[Math.round((i * (items.length - 1)) / (count - 1))]!,
  );
}

async function startsWithJpegSignature(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const head = Buffer.alloc(3);
    const { bytesRead } = await file.read(head, 0, 3, 0);
    return bytesRead === 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  } finally {
    await file.close();
  }
}
