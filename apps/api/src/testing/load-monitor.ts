/**
 * Test helper for the load and fault tests (T3.7, T7.8): what the machine and the API were doing during a run, so a
 * failed run tells an environment problem (low memory, a crowded PostgreSQL) from a defect (readiness that never
 * recovers). Two parts: resource samples every 10 s for the JSON report, and the API's readiness and refusal log
 * lines with their time relative to a moment of the run. Test code only; the API is not changed for it.
 */
import { execFile } from 'node:child_process';
import { freemem } from 'node:os';
import type { Client } from 'pg';

export interface ResourceSample {
  /** Milliseconds since the epoch. */
  at: number;
  /** `os.freemem()` in MB. */
  freeMemMb: number;
  /** The test (jest) process: `process.memoryUsage()` rss and external, in MB. */
  jestRssMb: number;
  jestExternalMb: number;
  /** Resident memory of the API process in MB; `null` when it could not be read. */
  apiRssMb: number | null;
  /** `pg_stat_activity` rows: the whole cluster and the test database; `max_connections`. `null` when unread. */
  connections: number | null;
  dbConnections: number | null;
  maxConnections: number | null;
}

export interface ResourceSampler {
  readonly samples: ResourceSample[];
  /** Stops sampling and waits for a sample under way. */
  stop(): Promise<ResourceSample[]>;
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

/** The memory column of `tasklist /FO CSV /NH` ("123.456 K" or "123,456 K", by locale) in KB; `null` if absent. */
export function parseTasklistKb(output: string): number | null {
  const fields = output
    .trim()
    .split('\n')[0]
    ?.match(/"([^"]*)"/g);
  if (!fields || fields.length < 5) return null;
  const digits = fields.at(-1)!.replace(/\D/g, '');
  return digits === '' ? null : Number(digits);
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile(file, args, { timeout: 5_000, windowsHide: true }, (error, stdout) =>
      done(error ? null : stdout),
    );
  });
}

/** Resident memory of process `pid` in MB: `tasklist` on Windows, `ps` elsewhere; `null` when unread. */
export async function processRssMb(pid: number | undefined): Promise<number | null> {
  if (pid === undefined) return null;
  if (process.platform === 'win32') {
    const out = await run('tasklist', ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH']);
    const kb = out === null ? null : parseTasklistKb(out);
    return kb === null ? null : mb(kb * 1024);
  }
  const out = await run('ps', ['-o', 'rss=', '-p', String(pid)]);
  const kb = out === null ? NaN : Number(out.trim());
  return Number.isFinite(kb) && out!.trim() !== '' ? mb(kb * 1024) : null;
}

async function connections(
  client: Pick<Client, 'query'> | undefined,
): Promise<Pick<ResourceSample, 'connections' | 'dbConnections' | 'maxConnections'>> {
  const none = { connections: null, dbConnections: null, maxConnections: null };
  if (!client) return none;
  try {
    const { rows } = await client.query<{ all: number; db: number; max: number }>(
      `SELECT count(*)::int AS all,
              (count(*) FILTER (WHERE datname = current_database()))::int AS db,
              current_setting('max_connections')::int AS max
         FROM pg_stat_activity`,
    );
    const row = rows[0];
    return row ? { connections: row.all, dbConnections: row.db, maxConnections: row.max } : none;
  } catch {
    return none;
  }
}

export async function sampleResources(sources: {
  apiPid?: number;
  client?: Pick<Client, 'query'>;
}): Promise<ResourceSample> {
  const at = Date.now();
  const own = process.memoryUsage();
  const [apiRssMb, pg] = await Promise.all([
    processRssMb(sources.apiPid),
    connections(sources.client),
  ]);
  return {
    at,
    freeMemMb: mb(freemem()),
    jestRssMb: mb(own.rss),
    jestExternalMb: mb(own.external),
    apiRssMb,
    ...pg,
  };
}

/**
 * Samples at once and then every `everyMs` (10 s) until `stop`. `client` is the test database's superuser client,
 * which `allowConnections(false)` leaves open, so the connection count is read during an outage too.
 */
export function startResourceSampler(
  sources: { apiPid?: number; client?: Pick<Client, 'query'> },
  everyMs = 10_000,
): ResourceSampler {
  const samples: ResourceSample[] = [];
  let busy: Promise<void> | undefined;
  const take = () => {
    if (busy) return;
    busy = sampleResources(sources)
      .then((s) => void samples.push(s))
      .finally(() => {
        busy = undefined;
      });
  };
  take();
  const timer = setInterval(take, everyMs);
  timer.unref();
  return {
    samples,
    async stop() {
      clearInterval(timer);
      await busy;
      return samples;
    },
  };
}

/** The lowest free memory, the highest RSS figures and connection count of `samples`, for the printed table. */
export function resourceSummary(samples: readonly ResourceSample[]): string {
  if (samples.length === 0) return 'no samples';
  const min = (f: (s: ResourceSample) => number | null) => {
    const values = samples.map(f).filter((v): v is number => v !== null);
    return values.length === 0 ? '—' : String(Math.min(...values));
  };
  const max = (f: (s: ResourceSample) => number | null) => {
    const values = samples.map(f).filter((v): v is number => v !== null);
    return values.length === 0 ? '—' : String(Math.max(...values));
  };
  return [
    `${String(samples.length)} samples`,
    `min free ${min((s) => s.freeMemMb)} MB`,
    `max jest rss ${max((s) => s.jestRssMb)} MB (external ${max((s) => s.jestExternalMb)} MB)`,
    `max API rss ${max((s) => s.apiRssMb)} MB`,
    `max connections ${max((s) => s.connections)} (test db ${max((s) => s.dbConnections)}) of ${max((s) => s.maxConnections)}`,
  ].join('; ');
}

const LEVELS: Record<number, string> = {
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

/**
 * The API log lines that show how readiness went: every `Readiness` line (checks failing, "DB: <error>", enabled
 * again), "Idle connection lost", and `Submit PO` refused with `DB_UNAVAILABLE` or `SUBMIT_DISABLED`; logged at or
 * after `since` (ms since the epoch).
 */
export function readinessLines(
  lines: readonly Record<string, unknown>[],
  since = 0,
): Record<string, unknown>[] {
  return lines.filter((l) => {
    if (typeof l.time === 'number' && l.time < since) return false;
    const msg = typeof l.msg === 'string' ? l.msg : '';
    return (
      l.context === 'Readiness' ||
      msg.includes('Idle connection lost') ||
      (msg === 'Submit PO' && (l.result === 'DB_UNAVAILABLE' || l.result === 'SUBMIT_DISABLED'))
    );
  });
}

/** One line per log line, `+12.3 s` from `origin`, at most `limit` (the rest counted at the end). */
export function formatLogLines(
  lines: readonly Record<string, unknown>[],
  origin: number,
  limit = 300,
): string {
  const shown = lines.slice(0, limit).map((l) => {
    const offset =
      typeof l.time === 'number' ? `${((l.time - origin) / 1000).toFixed(1)} s` : '? s';
    const level = typeof l.level === 'number' ? (LEVELS[l.level] ?? String(l.level)) : '?';
    const context = typeof l.context === 'string' ? `${l.context} ` : '';
    const msg = typeof l.msg === 'string' ? l.msg : JSON.stringify(l.msg);
    const result = typeof l.result === 'string' ? ` ${l.result}` : '';
    return `  ${offset.startsWith('-') ? '' : '+'}${offset} ${level} ${context}${msg}${result}`;
  });
  if (lines.length > limit) shown.push(`  … ${String(lines.length - limit)} more`);
  return shown.join('\n');
}
