import {
  formatLogLines,
  parseTasklistKb,
  processRssMb,
  readinessLines,
  resourceSummary,
  sampleResources,
  startResourceSampler,
} from './load-monitor';
import { waitFor } from './load-run';
import { summarise, formatReport } from './load-report';

const fakeClient = {
  query: () => Promise.resolve({ rows: [{ all: 23, db: 11, max: 100 }] }),
} as never;

describe('load monitor (T7.8 fault instrumentation)', () => {
  it('reads the memory column of tasklist in either locale', () => {
    expect(parseTasklistKb('"node.exe","4242","Console","1","123.456 K"\r\n')).toBe(123456);
    expect(parseTasklistKb('"node.exe","4242","Console","1","98,304 K"')).toBe(98304);
    expect(
      parseTasklistKb('INFO: No tasks are running which match the specified criteria.'),
    ).toBeNull();
  });

  it('samples free memory, the test process, the API process and the connections', async () => {
    const sample = await sampleResources({ apiPid: process.pid, client: fakeClient });
    expect(sample.freeMemMb).toBeGreaterThan(0);
    expect(sample.jestRssMb).toBeGreaterThan(0);
    expect(sample.jestExternalMb).toBeGreaterThanOrEqual(0);
    expect(sample.apiRssMb).toBeGreaterThan(0);
    expect(sample).toMatchObject({ connections: 23, dbConnections: 11, maxConnections: 100 });
  });

  it('gives null, not an error, for what it cannot read', async () => {
    const failing = { query: () => Promise.reject(new Error('down')) } as never;
    const sample = await sampleResources({ client: failing });
    expect(sample).toMatchObject({
      apiRssMb: null,
      connections: null,
      dbConnections: null,
      maxConnections: null,
    });
    expect(await processRssMb(undefined)).toBeNull();
  });

  it('samples at once and every interval until stopped, and the report carries the samples', async () => {
    const sampler = startResourceSampler({ client: fakeClient }, 20);
    await new Promise((r) => setTimeout(r, 90));
    const samples = await sampler.stop();
    const count = samples.length;
    expect(count).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 60));
    expect(samples).toHaveLength(count);

    const report = summarise({
      scenario: 'unit',
      settings: {},
      items: [],
      attempts: [],
      serverWriteMs: [],
      resources: samples,
    });
    expect(report.resources).toEqual(samples);
    expect(formatReport(report)).toContain('max connections 23 (test db 11) of 100');
    expect(resourceSummary([])).toBe('no samples');
  });

  it('keeps the readiness, idle-connection and refused Submit PO lines from a moment on', () => {
    const lines = [
      { time: 1_000, level: 40, context: 'Readiness', msg: 'DB: connect ECONNREFUSED' },
      {
        time: 5_000,
        level: 40,
        context: 'Readiness',
        msg: 'Submit PO is disabled: DB (Database not reachable)',
      },
      {
        time: 6_000,
        level: 40,
        context: 'Database',
        msg: 'Idle connection lost: terminating connection',
      },
      { time: 7_000, level: 40, msg: 'Submit PO', result: 'DB_UNAVAILABLE', status: 503 },
      { time: 7_500, level: 40, msg: 'Submit PO', result: 'SUBMIT_DISABLED', status: 503 },
      { time: 8_000, level: 30, msg: 'Submit PO', result: 'written', status: 201 },
      { time: 8_100, level: 30, msg: 'request completed' },
      {
        time: 9_000,
        level: 30,
        context: 'Readiness',
        msg: 'All readiness checks pass; Submit PO is enabled',
      },
    ];
    const kept = readinessLines(lines, 2_000);
    expect(kept.map((l) => l.time)).toEqual([5_000, 6_000, 7_000, 7_500, 9_000]);
    expect(formatLogLines(kept, 6_000, 4).split('\n')).toEqual([
      '  -1.0 s warn Readiness Submit PO is disabled: DB (Database not reachable)',
      '  +0.0 s warn Database Idle connection lost: terminating connection',
      '  +1.0 s warn Submit PO DB_UNAVAILABLE',
      '  +1.5 s warn Submit PO SUBMIT_DISABLED',
      '  … 1 more',
    ]);
  });

  it('waitFor names the last detail when it times out', async () => {
    await expect(
      waitFor(
        () => Promise.resolve(false),
        30,
        'SUBMIT_ENABLED',
        10,
        () => '503 {"checks":[]}',
      ),
    ).rejects.toThrow('Timed out after 30 ms: SUBMIT_ENABLED; last: 503 {"checks":[]}');
  });
});
