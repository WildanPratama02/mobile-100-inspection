/**
 * `pnpm backup [--kind daily|pre-upgrade]` (doc 03 §7.6): dumps the database with `MIGRATE_DATABASE_URL`, copies
 * `.env`, `secrets/` and `caddy-data/` of the working directory (the install folder) and the photo folder of a `disk`
 * store into `BACKUP_DIR`, then applies retention. `PG_BIN` names the PostgreSQL `bin` folder when `pg_dump` is not
 * on `PATH`. Prints one JSON line; exits 1 on any failure, which the nightly task reports (doc 03 §5.8).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type BackupKind, runBackup } from '../backup/backup';
import { loadCliEnv, requireEnv } from './device-env';

const KINDS: readonly BackupKind[] = ['daily', 'pre-upgrade'];

/** The `VERSION` file of the release this runs from (`<release>/api/dist/cli`), if any. */
function releaseVersion(): string | undefined {
  const file = resolve(__dirname, '..', '..', '..', 'VERSION');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { kind: { type: 'string', default: 'daily' } } });
  const kind = values.kind as BackupKind;
  if (!KINDS.includes(kind)) throw new Error(`--kind must be one of ${KINDS.join(', ')}`);
  loadCliEnv();
  const started = Date.now();
  const photoDir =
    process.env.PHOTO_STORE?.trim() === 'disk' ? resolve(requireEnv('PHOTO_DIR')) : undefined;
  const result = await runBackup({
    databaseUrl: requireEnv('MIGRATE_DATABASE_URL'),
    backupDir: resolve(requireEnv('BACKUP_DIR')),
    kind,
    root: process.cwd(),
    photoDir,
    release: releaseVersion(),
    pgBin: process.env.PG_BIN?.trim() || undefined,
  });
  process.stdout.write(
    `${JSON.stringify({
      level: 'info',
      time: new Date().toISOString(),
      msg: 'backup finished',
      kind,
      folder: result.folder,
      submissions: result.manifest.submissions,
      submissionPhotos: result.manifest.submissionPhotos,
      dumpBytes: result.manifest.dump.bytes,
      photos: result.manifest.photos,
      deleted: result.deleted,
      durationMs: Date.now() - started,
    })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      time: new Date().toISOString(),
      msg: 'backup failed',
      error: (error as Error).message,
    })}\n`,
  );
  process.exit(1);
});
