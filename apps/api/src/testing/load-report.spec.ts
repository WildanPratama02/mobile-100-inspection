import { percentile, summarise } from './load-report';

describe('load report (T3.7)', () => {
  it('takes the nearest-rank percentile', () => {
    const values = [15, 20, 35, 40, 50];
    expect(percentile(values, 50)).toBe(35);
    expect(percentile(values, 95)).toBe(50);
    expect(percentile(values, 0)).toBe(15);
    expect(
      percentile(
        [...Array(100).keys()].map((i) => i + 1),
        95,
      ),
    ).toBe(95);
    expect(percentile([3, 1, 2], 100)).toBe(3);
  });

  it('gives null for no values', () => {
    expect(percentile([], 95)).toBeNull();
  });

  it('counts answers and measures each submission from its first attempt to stored', () => {
    const report = summarise({
      scenario: 'unit',
      settings: {},
      items: [
        { submissionUuid: 'a', state: 'sent', firstAttemptAt: 0, doneAt: 5_300, attempts: 2 },
        { submissionUuid: 'b', state: 'sent', firstAttemptAt: 10, doneAt: 210, attempts: 1 },
        { submissionUuid: 'c', state: 'failed', firstAttemptAt: 0, doneAt: 50, attempts: 1 },
      ],
      attempts: [
        {
          submissionUuid: 'a',
          attempt: 1,
          startedAt: 0,
          latencyMs: 60_000,
          status: null,
          code: 'TIMEOUT',
        },
        { submissionUuid: 'a', attempt: 2, startedAt: 5_000, latencyMs: 300, status: 200 },
        { submissionUuid: 'b', attempt: 1, startedAt: 10, latencyMs: 200, status: 201 },
        {
          submissionUuid: 'c',
          attempt: 1,
          startedAt: 0,
          latencyMs: 50,
          status: 422,
          code: 'VALIDATION_FAILED',
        },
      ],
      serverWriteMs: [180],
    });
    expect(report.submissions).toEqual({ sent: 2, failed: 1 });
    expect(report.answers).toEqual({ none: 1, '200': 1, '201': 1, '422': 1 });
    expect(report.codes).toEqual({ TIMEOUT: 1, VALIDATION_FAILED: 1 });
    expect(report.perSubmissionMs).toEqual({ count: 2, p50: 200, p95: 5_300, max: 5_300 });
    expect(report.writeRequestMs).toEqual({ count: 1, p50: 200, p95: 200, max: 200 });
    expect(report.serverWriteMs.p95).toBe(180);
  });
});
