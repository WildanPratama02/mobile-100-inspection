/**
 * The real API for the end-to-end tests (T2.7: "against the API on localhost and the test database"). Global setup
 * builds the API, creates a throw-away `m100_test_e2e_*` database through `TEST_ADMIN_DATABASE_URL` (a local
 * superuser, dev only; read from `apps/api/.env` when not set, as the API's own database tests do), applies the
 * migrations, imports the web fixtures as the four old sheets plus the mapping workbook of `reference/mapping/`,
 * and starts the API on `E2E_API_PORT`. Never touches `m100` or `m100_dev`.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { defaultMapping } from '@m100/shared';
import pg from 'pg';
import { DB_CELL, USER_LIST } from '../../src/data/fixtures/masterSheets';
import { ALL_PO_MASTER } from '../../src/data/fixtures/pos';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const API_DIR = join(REPO_ROOT, 'apps', 'api');
const ROLES = ['m100_migrate', 'm100_app', 'm100_report'] as const;

/** Port of the API under test; the dev and preview servers proxy `/v1` there (playwright.config.ts). */
export const apiPort = (): number => Number(process.env.E2E_API_PORT ?? 3100);

/** Set by global setup for the tests: a superuser URL into the test database. */
export const DATABASE_ENV = 'E2E_DATABASE_URL';

function adminUrl(): URL {
  let value = process.env.TEST_ADMIN_DATABASE_URL?.trim();
  const envFile = join(API_DIR, '.env');
  if (!value && existsSync(envFile)) {
    const text = readFileSync(envFile, 'utf8');
    value = parseEnv(
      text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
    ).TEST_ADMIN_DATABASE_URL?.trim();
  }
  if (!value) {
    throw new Error(
      'TEST_ADMIN_DATABASE_URL is missing: the end-to-end tests need a PostgreSQL superuser URL in apps/api/.env',
    );
  }
  return new URL(value);
}

/** A connection string into `database` whose sessions run as `role`, as `apps/api/src/testing/database.ts` does. */
function urlFor(base: URL, database: string, role?: string): string {
  const url = new URL(base.href);
  url.pathname = `/${database}`;
  if (role) url.searchParams.set('options', `-c role=${role}`);
  return url.href;
}

function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    // pnpm is a .cmd on Windows.
    shell: command === 'pnpm',
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

/** Environment for the API's own processes: nothing from the developer's `.env`, which they would load from cwd. */
function apiEnv(values: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...values, TZ: 'Asia/Jakarta' };
  delete env.INIT_CWD;
  for (const name of ['DATABASE_URL', 'MIGRATE_DATABASE_URL', 'PHOTO_DIR', 'JWT_KEY_FILE']) {
    if (!(name in values)) delete env[name];
  }
  return env;
}

function csv(rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  const cell = (v: string | number | null) => {
    const text = v === null ? '' : String(v);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

/** The web fixtures as the four sheets `import-master` reads (doc 02 §5.1). */
function writeFixtureSheets(dir: string): void {
  writeFileSync(
    join(dir, 'USER_LIST.csv'),
    csv([
      ['ID', 'USERNAME', 'TYPE INSPECTION'],
      ...USER_LIST.map((u, i) => [i + 1, u.username, u.typeInspection]),
    ]),
  );
  writeFileSync(
    join(dir, 'DB_CELL.csv'),
    csv([['ID', 'FACTORY', 'CELL'], ...DB_CELL.map((c, i) => [i + 1, c.factory, c.cell])]),
  );
  writeFileSync(
    join(dir, 'ALL_PO_MASTER.csv'),
    csv([
      ['PO', 'ARTICLE', 'MODEL', 'DESTINATION', 'ORDER QTY', 'PODD', 'CRD'],
      ...ALL_PO_MASTER.map((p) => [
        p.po,
        p.article,
        p.model,
        p.destination,
        p.orderQty,
        p.podd,
        p.crd,
      ]),
    ]),
  );
  // Row r is D(r−1), in the order of the mapping; severities as the bundled mapping has them.
  writeFileSync(
    join(dir, 'DEFECT_LIST.csv'),
    csv([
      ['CTQ DEFECT CODE', 'DEFECT CLASSIFICATION', 'DEFECT NAME', 'CLASSIFICATION'],
      ...[...defaultMapping().defects]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((d, i) => [`52.${String(i + 1)}`, 'Category', d.name, d.classification]),
    ]),
  );
}

async function waitForHealth(url: string, api: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (api.exitCode !== null)
      throw new Error(`The API stopped (${String(api.exitCode)}):\n${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`The API did not answer ${url} within 60 s:\n${output()}`);
}

/** Starts everything; the returned function stops the API and drops the database. */
export async function startTestApi(): Promise<() => Promise<void>> {
  const base = adminUrl();
  const name = `m100_test_e2e_${String(process.pid)}_${randomBytes(4).toString('hex')}`;
  const scratch = mkdtempSync(join(tmpdir(), 'm100-e2e-'));
  let api: ChildProcess | undefined;

  const admin = new pg.Client({ connectionString: base.href, application_name: 'm100 e2e admin' });
  await admin.connect();
  try {
    for (const role of ROLES) {
      const { rowCount } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (!rowCount) await admin.query(`CREATE ROLE ${role} NOLOGIN`);
    }
    await admin.query(
      `CREATE DATABASE ${name} OWNER m100_migrate ENCODING 'UTF8' TEMPLATE template0`,
    );
    await admin.query(`ALTER DATABASE ${name} SET timezone TO 'Asia/Jakarta'`);
  } finally {
    await admin.end();
  }

  const stop = async () => {
    if (api && api.exitCode === null) {
      const exited = new Promise((r) => api!.once('exit', r));
      api.kill();
      await exited;
    }
    const cleanup = new pg.Client({
      connectionString: base.href,
      application_name: 'm100 e2e cleanup',
    });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
    rmSync(scratch, { recursive: true, force: true });
  };

  try {
    if (!process.env.E2E_SKIP_API_BUILD)
      run('pnpm', ['--filter', 'api', 'build'], { cwd: REPO_ROOT });
    const dist = join(API_DIR, 'dist');
    run(process.execPath, [join(dist, 'cli', 'db-migrate.js')], {
      cwd: scratch,
      env: apiEnv({ MIGRATE_DATABASE_URL: urlFor(base, name, 'm100_migrate') }),
    });
    const sheets = join(scratch, 'sheets');
    mkdirSync(sheets);
    writeFixtureSheets(sheets);
    run(process.execPath, [join(dist, 'cli', 'import-master.js'), '--dir', sheets], {
      cwd: scratch,
      env: apiEnv({ DATABASE_URL: urlFor(base, name, 'm100_app') }),
    });

    const jwtKey = join(scratch, 'jwt.key');
    writeFileSync(jwtKey, randomBytes(32));
    const photos = mkdtempSync(join(scratch, 'photos-'));
    let output = '';
    api = spawn(process.execPath, [join(dist, 'main.js')], {
      cwd: scratch,
      env: apiEnv({
        DATABASE_URL: urlFor(base, name, 'm100_app'),
        PHOTO_STORE: 'disk',
        PHOTO_DIR: photos,
        JWT_KEY_FILE: jwtKey,
        PORT: String(apiPort()),
        LOG_LEVEL: 'warn',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    api.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    api.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    await waitForHealth(`http://127.0.0.1:${String(apiPort())}/v1/health`, api, () => output);
  } catch (error) {
    await stop();
    throw error;
  }

  process.env[DATABASE_ENV] = urlFor(base, name);
  return stop;
}
