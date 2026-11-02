/**
 * T3.7 fault test with T7.8's photo figure (NFR-06, BR-06, doc 04 §5): the database stops while `LOAD_TABLETS`
 * (50) tablets are sending, stays stopped for `FAULT_OUTAGE_SECONDS` (600) while each tablet seals one more
 * submission — `LOAD_PHOTOS` (15) photos — then starts again. Every submission must end stored exactly once.
 * "Stopped" is `ALLOW_CONNECTIONS false` plus cutting the API's connections (`TestDatabase.allowConnections`):
 * what the API sees of a stopped PostgreSQL, without stopping the developer's whole cluster. Runs only with
 * `pnpm test:load`.
 */
import { RETRY_MS } from '../master-data/readiness.service';
import { formatLogLines, readinessLines, startResourceSampler } from '../testing/load-monitor';
import { publishReport, summarise } from '../testing/load-report';
import {
  checkStored,
  envNumber,
  type LoadRun,
  settledWriteDurations,
  startLoadRun,
  waitFor,
} from '../testing/load-run';
import { type Attempt, BACKOFF_MS, psiSubmission, runTablet } from '../testing/tablet-sim';

const TABLETS = envNumber('LOAD_TABLETS', 50);
const OUTAGE_MS = envNumber('FAULT_OUTAGE_SECONDS', 600) * 1000;
const PHOTO_COUNT = envNumber('LOAD_PHOTOS', 15);
const PHOTO_BYTES = envNumber('LOAD_PHOTO_KB', 200) * 1024;
/** The database stops this long after the first submissions start, while they are in flight (a burst takes ≈ 2 s). */
const CUT_AFTER_MS = 1_000;
/** A failing readiness check is repeated every 30 s; one check may take up to 5 s (doc 02 §10). */
const REENABLE_MS = RETRY_MS + 5_000;
/** After the restart the longest wait of a tablet is one 5 min back-off, plus sending. */
const DRAIN_MS = BACKOFF_MS[3] + 2 * 60_000;

let run: LoadRun;

/**
 * Prints the API's Readiness, "Idle connection lost" and refused Submit PO lines from the last readiness run before
 * the restart on, each with its time relative to the restart (review-1 "How to confirm" 2): whether the checks ran
 * and what failed, or whether failures kept coming.
 */
function printReadiness(restartedAt: number): void {
  const lines = readinessLines(run.api.logLines(), restartedAt - REENABLE_MS);
  process.stdout.write(
    `API readiness log around the restart (${String(lines.length)} lines, time from the restart):
${formatLogLines(lines, restartedAt)}
`,
  );
}

beforeAll(async () => {
  run = await startLoadRun();
  await waitFor(
    async () => (await run.submitEnabled()) === true,
    60_000,
    'SUBMIT_ENABLED',
    1_000,
    () => run.lastStatus(),
  );
}, 120_000);

afterAll(async () => {
  await run?.close();
});

it(
  `database stopped for ${String(OUTAGE_MS / 1000)} s while ${String(TABLETS)} tablets send: every submission stored exactly once`,
  async () => {
    const tablets = await run.tablets(TABLETS);
    const first = tablets.map(() => psiSubmission(PHOTO_BYTES, PHOTO_COUNT));
    const second = tablets.map(() => psiSubmission(PHOTO_BYTES, PHOTO_COUNT));
    const attempts: Attempt[] = [];
    // Memory and connections every 10 s, into the JSON report (review-1 "How to confirm" 3).
    const sampler = startResourceSampler({ apiPid: run.api.pid, client: run.db.client });
    const t0 = Date.now();
    const cutAt = t0 + CUT_AFTER_MS;

    const sending = Promise.all(
      tablets.map((tablet, i) =>
        runTablet({
          baseUrl: run.api.baseUrl,
          deviceKey: tablet.deviceKey,
          token: tablet.token,
          outbox: [first[i]!],
          // Sealed while the database is down; it waits behind the first one, as in the tablet's outbox.
          later: [{ at: cutAt + Math.floor(Math.random() * OUTAGE_MS), item: second[i]! }],
          onAttempt: (a) => attempts.push(a),
        }),
      ),
    );

    await new Promise((r) => setTimeout(r, Math.max(0, cutAt - Date.now())));
    const stoppingAt = Date.now();
    await run.db.allowConnections(false);
    const stoppedAt = Date.now();
    await new Promise((r) => setTimeout(r, OUTAGE_MS));
    await run.db.allowConnections(true);
    const startedAt = Date.now();
    const settings = {
      tablets: TABLETS,
      outageSeconds: OUTAGE_MS / 1000,
      photos: PHOTO_COUNT,
      photoKb: PHOTO_BYTES / 1024,
    };
    let enabledAt: number;
    try {
      enabledAt = await waitFor(
        async () => (await run.submitEnabled()) === true,
        REENABLE_MS + 10_000,
        'SUBMIT_ENABLED after the restart',
        1_000,
        () => run.lastStatus(),
      );
    } catch (error) {
      printReadiness(startedAt);
      publishReport(
        summarise({
          scenario: 'fault database outage not re-enabled',
          settings,
          items: [],
          attempts,
          serverWriteMs: [],
          resources: await sampler.stop(),
        }),
      );
      throw error;
    }
    printReadiness(startedAt);

    let timer: NodeJS.Timeout | undefined;
    const items = (
      await Promise.race([
        sending,
        new Promise<never>((_, fail) => {
          timer = setTimeout(
            () => fail(new Error(`Outboxes not empty ${String(DRAIN_MS)} ms after the restart`)),
            DRAIN_MS,
          );
        }),
      ]).finally(() => clearTimeout(timer))
    ).flat();
    const lastStoredAt = Math.max(...items.map((i) => i.doneAt));
    // Requests under way when the database stopped: some may still have finished, the others were cut.
    const inFlight = attempts.filter(
      (a) => a.startedAt < stoppingAt && a.startedAt + a.latencyMs > stoppedAt,
    );
    const cut = inFlight.filter((a) => a.status !== 201);

    publishReport(
      summarise({
        scenario: 'fault database outage',
        settings: {
          ...settings,
          inFlightAtStop: inFlight.length,
          cutAtStop: cut.length,
          reenabledAfterMs: enabledAt - startedAt,
          lastStoredAfterRestartMs: lastStoredAt - startedAt,
        },
        items,
        attempts,
        serverWriteMs: await settledWriteDurations(
          run.api,
          0,
          attempts.filter((a) => a.status === 201).length,
        ),
        resources: await sampler.stop(),
      }),
    );

    expect(cut.length).toBeGreaterThan(0);
    // Nothing refused, nothing lost: every one of the 2 × TABLETS ended sent.
    expect(items).toHaveLength(2 * TABLETS);
    expect(items.filter((i) => i.state !== 'sent')).toEqual([]);
    expect(attempts.filter((a) => a.status !== null && a.status >= 400 && a.status < 500)).toEqual(
      [],
    );
    // A database error is a 503 the tablet waits on, never a 500 (doc 03 §5.7).
    expect(attempts.filter((a) => a.status === 500)).toEqual([]);
    // Requests made while the database was down: 503 DB_UNAVAILABLE / SUBMIT_DISABLED, or no answer.
    const duringOutage = attempts.filter(
      (a) => a.startedAt > stoppedAt + 1_000 && a.startedAt + a.latencyMs < startedAt,
    );
    expect(duringOutage.length).toBeGreaterThan(0);
    expect(
      duringOutage.filter(
        (a) =>
          a.status !== null &&
          !(a.status === 503 && ['DB_UNAVAILABLE', 'SUBMIT_DISABLED'].includes(a.code ?? '')),
      ),
    ).toEqual([]);
    expect(enabledAt - startedAt).toBeLessThanOrEqual(REENABLE_MS);

    // Exactly once: one row per UUID with its findings, photo rows and files; no stray file.
    const stored = await checkStored(run.db, run.api.photoDir, [...first, ...second]);
    expect(stored).toEqual({
      notOnce: [],
      incomplete: [],
      badFiles: [],
      orphanFiles: [],
      totalRows: 2 * TABLETS,
    });
  },
  CUT_AFTER_MS + OUTAGE_MS + REENABLE_MS + DRAIN_MS + 5 * 60_000,
);
