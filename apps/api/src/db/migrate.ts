/**
 * The migration runner behind `pnpm db:migrate` (T2.2, doc 03 §5.1, §7.6). Applies the explicit SQL files of
 * `db/migrations/` in name order, each in its own transaction, and records them in `schema_migrations`. Run as
 * `m100_migrate`; there is no schema auto-sync anywhere.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ClientBase } from 'pg';

export interface Migration {
  /** File name without `.sql`, e.g. `0003_submissions`. */
  version: string;
  sql: string;
  /** Hex SHA-256 of the file's bytes; an applied file must never change. */
  sha256: string;
}

const FILE = /^(\d{4}_[a-z0-9_]+)\.sql$/;

/** Any key will do as long as every runner uses the same one; it keeps two runs from interleaving. */
const LOCK_KEY = 1_000_100_002;

/**
 * `db/migrations` in the nearest ancestor of `from` that has one: the repository root in development (from `src` or
 * `dist`), the release folder on the server.
 */
export function findMigrationsDir(from: string = __dirname): string {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const candidate = join(dir, 'db', 'migrations');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error(`No db/migrations folder above ${from}`);
  }
}

/** Every migration file in version order. A `.sql` file whose name does not follow `0000_name.sql` is an error. */
export function listMigrations(dir: string = findMigrationsDir()): Migration[] {
  const files = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.sql'))
    .sort();
  return files.map((name) => {
    const match = FILE.exec(name);
    if (!match?.[1]) throw new Error(`Migration file name must look like 0001_name.sql: ${name}`);
    const bytes = readFileSync(join(dir, name));
    return {
      version: match[1],
      sql: bytes.toString('utf8'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Applies the pending migrations on `client` (connected as the database owner). Stops before writing anything if
 * an applied migration's file changed or disappeared, naming it.
 */
export async function migrate(
  client: ClientBase,
  migrations: readonly Migration[] = listMigrations(),
): Promise<MigrateResult> {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text        PRIMARY KEY,
        sha256     text        NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string; sha256: string }>(
      'SELECT version, sha256 FROM schema_migrations ORDER BY version',
    );
    const known = new Map(migrations.map((m) => [m.version, m]));
    for (const row of rows) {
      const file = known.get(row.version);
      if (!file) throw new Error(`Applied migration ${row.version} has no file in db/migrations`);
      if (file.sha256 !== row.sha256) {
        throw new Error(
          `Applied migration ${row.version} was changed after it ran; add a new migration instead`,
        );
      }
    }

    const done = new Set(rows.map((r) => r.version));
    const result: MigrateResult = { applied: [], alreadyApplied: [...done] };
    for (const m of migrations) {
      if (done.has(m.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, sha256) VALUES ($1, $2)', [
          m.version,
          m.sha256,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.version} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
      result.applied.push(m.version);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}
