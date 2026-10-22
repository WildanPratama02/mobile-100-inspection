/**
 * T3.7 load test (NFR-07, doc 03 §8 "Load", T12): `LOAD_TABLETS` (50) simulated tablets, each sending one PSI lv.2
 * submission with five photos of `LOAD_PHOTO_KB` (200) KB to the built API process: all at once, and spread over
 * `LOAD_WINDOW_SECONDS` (300). No loss, no duplicate; the p95 per submission is printed and written as JSON.
 * Runs only with `pnpm test:load`.
 */
import { publishReport, summarise } from '../testing/load-report';
import {
  checkStored,
  envNumber,
  type LoadRun,
  settledWriteDurations,
  startLoadRun,
  waitFor,
} from '../testing/load-run';
import { type Attempt, fiveDefectSubmission, runTablet } from '../testing/tablet-sim';

const TABLETS = envNumber('LOAD_TABLETS', 50);
const WINDOW_MS = envNumber('LOAD_WINDOW_SECONDS', 300) * 1000;
const PHOTO_BYTES = envNumber('LOAD_PHOTO_KB', 200) * 1024;

let run: LoadRun;

beforeAll(async () => {
  run = await startLoadRun();
  await waitFor(async () => (await run.submitEnabled()) === true, 60_000, 'SUBMIT_ENABLED');
}, 120_000);

afterAll(async () => {
  await run?.close();
});

async function scenario(name: string, startOffset: () => number): Promise<void> {
  const tablets = await run.tablets(TABLETS);
  const sealed = tablets.map(() => fiveDefectSubmission(PHOTO_BYTES));
  const attempts: Attempt[] = [];
  const linesBefore = run.api.logLines().length;
  const t0 = Date.now();

  const items = (
    await Promise.all(
      tablets.map((tablet, i) =>
        runTablet({
          baseUrl: run.api.baseUrl,
          deviceKey: tablet.deviceKey,
          token: tablet.token,
          outbox: [],
          later: [{ at: t0 + startOffset(), item: sealed[i]! }],
          onAttempt: (a) => attempts.push(a),
        }),
      ),
    )
  ).flat();

  publishReport(
    summarise({
      scenario: name,
      settings: { tablets: TABLETS, windowSeconds: WINDOW_MS / 1000, photoKb: PHOTO_BYTES / 1024 },
      items,
      attempts,
      serverWriteMs: await settledWriteDurations(
        run.api,
        linesBefore,
        attempts.filter((a) => a.status === 201).length,
      ),
    }),
  );

  // No loss: every submission answered 201 or 200, none refused.
  expect(items.filter((i) => i.state !== 'sent')).toEqual([]);
  expect(items).toHaveLength(TABLETS);
  expect(attempts.filter((a) => a.status !== null && a.status >= 400 && a.status < 500)).toEqual(
    [],
  );
  // A 200 only ever follows an attempt without a 201 answer (a resend after a timeout or a 5xx).
  for (const item of items) {
    if (item.status === 200) expect(item.attempts).toBeGreaterThan(1);
  }

  // No duplicate: one row each, with its findings, photo rows and files; no stray file.
  const stored = await checkStored(run.db, run.api.photoDir, sealed);
  expect(stored).toMatchObject({ notOnce: [], incomplete: [], badFiles: [], orphanFiles: [] });
}

describe(`load: ${String(TABLETS)} tablets, five photos each (T3.7, NFR-07)`, () => {
  let sentSoFar = 0;

  it(
    'burst: every tablet submits at the same moment',
    async () => {
      await scenario('load burst', () => 0);
      sentSoFar += TABLETS;
      expect((await checkStored(run.db, run.api.photoDir, [])).totalRows).toBe(sentSoFar);
    },
    WINDOW_MS + 10 * 60_000,
  );

  it(
    `spread: tablets start at random moments within ${String(WINDOW_MS / 1000)} s`,
    async () => {
      await scenario('load spread', () => Math.floor(Math.random() * WINDOW_MS));
      sentSoFar += TABLETS;
      expect((await checkStored(run.db, run.api.photoDir, [])).totalRows).toBe(sentSoFar);
    },
    WINDOW_MS + 10 * 60_000,
  );
});
