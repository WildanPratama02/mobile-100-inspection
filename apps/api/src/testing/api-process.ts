/**
 * Test helper for the load and fault tests (T3.7): the built API (`dist/main.js`, from `pnpm --filter api build`)
 * as its own process against a test database, the way it runs on the server, so simulated tablets in the test
 * process never share its event loop. Disk photo store and signing key in a scratch folder that `stop` removes;
 * nothing from the developer's `.env` reaches it (it runs in the scratch folder and those variables are dropped).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestDatabase } from './database';

export interface ApiProcess {
  baseUrl: string;
  photoDir: string;
  /** The JSON log lines written so far. */
  logLines(): Record<string, unknown>[];
  stop(): Promise<void>;
}

const MAIN = resolve(__dirname, '..', '..', 'dist', 'main.js');

/** Variables of the API that must come from here only, never from the developer's environment. */
const API_VARIABLES = [
  'DATABASE_URL',
  'MIGRATE_DATABASE_URL',
  'PHOTO_STORE',
  'PHOTO_DIR',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'JWT_KEY_FILE',
  'PORT',
  'LOG_LEVEL',
  'MASTER_CHECK_SECONDS',
  'SUBMIT_TIMEOUT_SECONDS',
  'INIT_CWD',
];

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address ? done(address.port) : fail(new Error('No port')),
      );
    });
  });
}

async function waitForHealth(url: string, api: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) {
      throw new Error(`The API stopped (${String(api.exitCode)}):\n${output()}`);
    }
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`The API did not answer ${url} within 60 s:\n${output()}`);
}

export async function startApiProcess(db: TestDatabase): Promise<ApiProcess> {
  if (!existsSync(MAIN)) {
    throw new Error(`${MAIN} is missing: build the API first (pnpm --filter api build)`);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'm100-load-'));
  const photoDir = join(scratch, 'photos');
  mkdirSync(photoDir);
  const jwtKey = join(scratch, 'jwt.key');
  writeFileSync(jwtKey, randomBytes(32));
  const port = await freePort();

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of API_VARIABLES) delete env[name];
  Object.assign(env, {
    DATABASE_URL: db.url('m100_app'),
    PHOTO_STORE: 'disk',
    PHOTO_DIR: photoDir,
    JWT_KEY_FILE: jwtKey,
    PORT: String(port),
    LOG_LEVEL: 'info',
    TZ: 'Asia/Jakarta',
  });

  const lines: Record<string, unknown>[] = [];
  let rest = '';
  let other = '';
  const api = spawn(process.execPath, [MAIN], {
    cwd: scratch,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stdout?.on('data', (chunk: Buffer) => {
    const parts = (rest + chunk.toString('utf8')).split('\n');
    rest = parts.pop() ?? '';
    for (const line of parts.filter(Boolean)) {
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        other += `${line}\n`;
      }
    }
  });
  api.stderr?.on('data', (chunk: Buffer) => (other += chunk.toString('utf8')));

  const stop = async () => {
    if (api.exitCode === null) {
      const exited = new Promise((r) => api.once('exit', r));
      api.kill();
      await exited;
    }
    rmSync(scratch, { recursive: true, force: true });
  };

  const baseUrl = `http://127.0.0.1:${String(port)}`;
  try {
    await waitForHealth(`${baseUrl}/v1/health`, api, () => other);
  } catch (error) {
    await stop();
    throw error;
  }
  return { baseUrl, photoDir, logLines: () => lines, stop };
}
