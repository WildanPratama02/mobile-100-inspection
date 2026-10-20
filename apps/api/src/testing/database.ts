/**
 * Test helper: a fresh PostgreSQL database per test file (T2.2, doc 03 §8), created through the superuser in
 * `TEST_ADMIN_DATABASE_URL` (dev machines only; read from `apps/api/.env` when not already set) and dropped
 * afterwards. Roles are cluster-wide; they are created without login when missing, so the grants can be checked
 * with `SET ROLE`. Never points at `m100` or `m100_dev`.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { Client, type ClientBase } from 'pg';
import { ensureRole, ROLES } from '../db/bootstrap';
import { migrate } from '../db/migrate';

export type Role = (typeof ROLES)[keyof typeof ROLES];

export interface TestDatabase {
  readonly name: string;
  /** Superuser connection into the test database. Sequential use only. */
  readonly client: Client;
  /**
   * Runs `fn` in a transaction as `role` and rolls it back, also when `fn` throws (the error is passed on). With
   * `commit`, the transaction is committed instead.
   */
  as<T>(role: Role, fn: (db: ClientBase) => Promise<T>, options?: { commit?: boolean }): Promise<T>;
  drop(): Promise<void>;
}

/** The superuser URL of `TEST_ADMIN_DATABASE_URL`; throws, naming the variable, when it is not set. */
export function adminUrl(): URL {
  const envFile = resolve(__dirname, '..', '..', '.env');
  let value = process.env.TEST_ADMIN_DATABASE_URL?.trim();
  if (!value && existsSync(envFile)) {
    // Not process.loadEnvFile: under Jest it fills the real process.env, not the test sandbox's copy. A BOM (as
    // Notepad may write) would hide the first key from parseEnv.
    const text = readFileSync(envFile, 'utf8');
    value = parseEnv(
      text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
    ).TEST_ADMIN_DATABASE_URL?.trim();
  }
  if (!value) {
    throw new Error(
      'TEST_ADMIN_DATABASE_URL is missing: database tests need a PostgreSQL superuser URL in apps/api/.env',
    );
  }
  return new URL(value);
}

async function connect(url: URL, label: string): Promise<Client> {
  const client = new Client({ connectionString: url.href, application_name: `m100 test ${label}` });
  await client.connect();
  return client;
}

/** Creates an empty test database owned by `m100_migrate`; with `migrated`, applies `db/migrations` as that role. */
export async function createTestDatabase(
  options: { migrated?: boolean } = {},
): Promise<TestDatabase> {
  const base = adminUrl();
  const name = `m100_test_${process.pid}_${randomBytes(4).toString('hex')}`;

  const admin = await connect(base, 'admin');
  try {
    for (const role of Object.values(ROLES)) await ensureRole(admin, role);
    await admin.query(
      `CREATE DATABASE ${name} OWNER ${ROLES.migrate} ENCODING 'UTF8' TEMPLATE template0`,
    );
    await admin.query(`ALTER DATABASE ${name} SET timezone TO 'Asia/Jakarta'`);
  } finally {
    await admin.end();
  }

  const url = new URL(base.href);
  url.pathname = `/${name}`;
  const client = await connect(url, name);

  const db: TestDatabase = {
    name,
    client,
    async as(role, fn, { commit = false } = {}) {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL ROLE ${role}`);
        const result = await fn(client);
        await client.query(commit ? 'COMMIT' : 'ROLLBACK');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
    async drop() {
      await client.end();
      const cleanup = await connect(base, 'cleanup');
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };

  if (options.migrated) await migrateAsOwner(db);
  return db;
}

/** Runs the migration runner as `m100_migrate`, the way `pnpm db:migrate` does on a real database. */
export async function migrateAsOwner(db: TestDatabase): ReturnType<typeof migrate> {
  await db.client.query(`SET ROLE ${ROLES.migrate}`);
  try {
    return await migrate(db.client);
  } finally {
    await db.client.query('RESET ROLE');
  }
}

/** The SQLSTATE of a failed query, e.g. `42501` for a missing privilege. */
export async function sqlState(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
  throw new Error('Expected the statement to fail, but it succeeded');
}
