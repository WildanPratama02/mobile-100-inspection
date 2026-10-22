/**
 * Test helper for the load and fault tests (T3.7): a migrated test database with the fixture master data, the
 * built API as its own process on it, registered and logged-in tablets, and the checks that every submission is
 * stored exactly once with its findings, photo rows and files (doc 02 §6, BR-06).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Database } from '../db/database';
import { importMaster, pgImportRepositories } from '../import/import-master';
import { parseMaster } from '../import/parse-master';
import { type ApiProcess, startApiProcess } from './api-process';
import { createTestDatabase, type TestDatabase } from './database';
import { registerDevice } from './devices';
import { fixtureTables } from './master-fixtures';
import type { SealedSubmission } from './tablet-sim';

/** A whole number from the environment, else `fallback` (the acceptance figure of the plan). */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a whole number > 0`);
  return value;
}

export interface Tablet {
  deviceKey: string;
  token: string;
}

export interface LoadRun {
  db: TestDatabase;
  api: ApiProcess;
  /** Registers `count` tablets and logs `TEST BUDI` in on each through `POST /v1/auth/login`. */
  tablets(count: number): Promise<Tablet[]>;
  /** `GET /v1/system/status` with a registered tablet's key. */
  submitEnabled(): Promise<boolean | null>;
  close(): Promise<void>;
}

export async function startLoadRun(): Promise<LoadRun> {
  const db = await createTestDatabase({ migrated: true });
  let api: ApiProcess | undefined;
  try {
    const pool = db.pool('m100_app');
    const database = new Database(pool);
    await importMaster(
      database,
      pgImportRepositories(database),
      parseMaster(await fixtureTables()),
      {
        dryRun: false,
      },
    );
    api = await startApiProcess(db);
  } catch (error) {
    await db.drop();
    throw error;
  }
  const started = api;
  const probe = await registerDevice(db.client, 'Load probe');

  const run: LoadRun = {
    db,
    api: started,
    async tablets(count) {
      const tablets: Tablet[] = [];
      for (let i = 0; i < count; i++) {
        const device = await registerDevice(db.client);
        const response = await fetch(`${started.baseUrl}/v1/auth/login`, {
          method: 'POST',
          headers: { 'X-Device-Key': device.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'TEST BUDI',
            level: 'PSI lv.2',
            factory: 'F 1',
            cell: 'F1-1',
          }),
        });
        if (response.status !== 200) {
          throw new Error(`Login failed (${String(response.status)}): ${await response.text()}`);
        }
        const { token } = (await response.json()) as { token: string };
        tablets.push({ deviceKey: device.key, token });
      }
      return tablets;
    },
    async submitEnabled() {
      try {
        const response = await fetch(`${started.baseUrl}/v1/system/status`, {
          headers: { 'X-Device-Key': probe.key },
        });
        if (!response.ok) return null;
        return ((await response.json()) as { submitEnabled: boolean }).submitEnabled;
      } catch {
        return null;
      }
    },
    async close() {
      await db.allowConnections(true).catch(() => undefined);
      await started.stop();
      await db.drop();
    },
  };
  return run;
}

/** Polls `until` every `everyMs` and resolves to the time it first held (ms since the epoch), or throws. */
export async function waitFor(
  until: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
  everyMs = 1_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await until()) return Date.now();
    if (Date.now() > deadline) throw new Error(`Timed out after ${String(timeoutMs)} ms: ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

export interface StoredCheck {
  /** UUIDs with a number of `submissions` rows other than one. */
  notOnce: Array<{ id: string; rows: number }>;
  /** Submissions whose findings or photo rows differ from what was sent. */
  incomplete: Array<{ id: string; findings: number; photos: number }>;
  /** Photo rows whose file is missing or holds other bytes. */
  badFiles: string[];
  /** Files under `submissions/` that no photo row points to. */
  orphanFiles: string[];
  /** All `submissions` rows, to compare with what was sent. */
  totalRows: number;
}

/** What the database and the photo folder hold for `sent`; everything empty and `totalRows` = `sent.length` is good. */
export async function checkStored(
  db: TestDatabase,
  photoDir: string,
  sent: readonly SealedSubmission[],
): Promise<StoredCheck> {
  const ids = sent.map((s) => s.submissionUuid);
  const { rows } = await db.client.query<{
    id: string;
    rows: number;
    findings: number;
    photos: number;
  }>(
    `SELECT u.id::text AS id,
            (SELECT count(*)::int FROM submissions s WHERE s.id = u.id) AS rows,
            (SELECT count(*)::int FROM submission_findings f WHERE f.submission_id = u.id) AS findings,
            (SELECT count(*)::int FROM submission_photos p WHERE p.submission_id = u.id) AS photos
       FROM unnest($1::uuid[]) AS u(id)`,
    [ids],
  );
  const expected = new Map(
    sent.map((s) => [
      s.submissionUuid,
      {
        findings: (JSON.parse(s.json) as { findings: unknown[] }).findings.length,
        photos: s.photos.length,
      },
    ]),
  );
  const photoRows = await db.client.query<{ key: string; sha256: Buffer }>(
    'SELECT object_key AS key, sha256 FROM submission_photos',
  );
  const keys = new Set(photoRows.rows.map((r) => r.key));
  const badFiles = photoRows.rows
    .filter((r) => {
      const file = join(photoDir, ...r.key.split('/'));
      return (
        !existsSync(file) ||
        !createHash('sha256').update(readFileSync(file)).digest().equals(r.sha256)
      );
    })
    .map((r) => r.key);
  const orphanFiles = filesUnder(join(photoDir, 'submissions'))
    .map((file) => relative(photoDir, file).split(sep).join('/'))
    .filter((key) => !keys.has(key));
  const total = await db.client.query<{ n: number }>('SELECT count(*)::int AS n FROM submissions');
  return {
    notOnce: rows.filter((r) => r.rows !== 1).map((r) => ({ id: r.id, rows: r.rows })),
    incomplete: rows
      .filter((r) => {
        const want = expected.get(r.id)!;
        return r.rows === 1 && (r.findings !== want.findings || r.photos !== want.photos);
      })
      .map((r) => ({ id: r.id, findings: r.findings, photos: r.photos })),
    badFiles,
    orphanFiles,
    totalRows: total.rows[0]!.n,
  };
}

/** `durationMs` of the API's `Submit PO` log lines that wrote a submission (NFR-10, doc 03 §5.8). */
export function serverWriteDurations(lines: readonly Record<string, unknown>[]): number[] {
  return lines
    .filter(
      (l) => l.msg === 'Submit PO' && l.result === 'written' && typeof l.durationMs === 'number',
    )
    .map((l) => l.durationMs as number);
}

/**
 * The write durations logged from line `since` on, once `expected` of them have come through the API's stdout
 * pipe (it may lag behind the answers), or after 10 s with what has come.
 */
export async function settledWriteDurations(
  api: ApiProcess,
  since: number,
  expected: number,
): Promise<number[]> {
  const read = () => serverWriteDurations(api.logLines().slice(since));
  await waitFor(() => Promise.resolve(read().length >= expected), 10_000, 'log lines', 100).catch(
    () => undefined,
  );
  return read();
}
