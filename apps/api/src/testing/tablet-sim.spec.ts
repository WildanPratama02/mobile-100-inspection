import { createHash } from 'node:crypto';
import {
  type Attempt,
  BACKOFF_MS,
  fiveDefectSubmission,
  runTablet,
  type SealedSubmission,
  type TabletOptions,
} from './tablet-sim';

type Reply = { status: number; body?: object; retryAfter?: number } | 'timeout' | 'offline';

/** A fake clock and a fetch that answers `replies` in order; every request body is kept as bytes. */
function harness(replies: Reply[]) {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const bodies: string[] = [];
  const attempts: Attempt[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
    // The multipart boundary differs per request; the parts must not.
    const boundary = /^--([^\r\n]+)/.exec(bytes.toString('latin1'))![1]!;
    bodies.push(
      createHash('sha256').update(bytes.toString('latin1').replaceAll(boundary, 'B')).digest('hex'),
    );
    clock += 100;
    const reply = replies.shift() ?? { status: 201 };
    if (reply === 'timeout') throw new DOMException('timed out', 'TimeoutError');
    if (reply === 'offline') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(reply.body ?? { displayNo: 'M100-000001' }), {
      status: reply.status,
      headers: reply.retryAfter === undefined ? {} : { 'Retry-After': String(reply.retryAfter) },
    });
  }) as typeof fetch;
  const options = (outbox: SealedSubmission[]): TabletOptions => ({
    baseUrl: 'http://api',
    deviceKey: 'k',
    token: 't',
    outbox,
    fetch: fakeFetch,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    onAttempt: (a) => attempts.push(a),
  });
  return { options, sleeps, bodies, attempts };
}

const item = () => fiveDefectSubmission(64);

describe('simulated tablet outbox (doc 04 §5)', () => {
  it('backs off 5 s, 15 s, 1 min, 5 min, then every 5 min, resending the same bytes', async () => {
    const h = harness([
      { status: 503, body: { code: 'DB_UNAVAILABLE' } },
      'offline',
      'timeout',
      { status: 500 },
      { status: 503 },
      { status: 200 },
    ]);
    const [done] = await runTablet(h.options([item()]));
    expect(h.sleeps).toEqual([...BACKOFF_MS, BACKOFF_MS[3]]);
    expect(new Set(h.bodies).size).toBe(1);
    expect(done).toMatchObject({ state: 'sent', attempts: 6, status: 200 });
    expect(h.attempts.map((a) => a.code ?? a.status)).toEqual([
      'DB_UNAVAILABLE',
      'NETWORK',
      'TIMEOUT',
      500,
      503,
      200,
    ]);
  });

  it('waits Retry-After when the answer carries it', async () => {
    const h = harness([
      { status: 429, retryAfter: 7 },
      { status: 503, retryAfter: 30 },
    ]);
    await runTablet(h.options([item()]));
    expect(h.sleeps).toEqual([7_000, 30_000]);
  });

  it('a refused answer is Gagal and is never resent; the next item goes on', async () => {
    const h = harness([{ status: 409, body: { code: 'SUBMISSION_UUID_REUSED' } }, { status: 201 }]);
    const first = item();
    const second = item();
    const done = await runTablet(h.options([first, second]));
    expect(done.map((d) => [d.submissionUuid, d.state, d.attempts])).toEqual([
      [first.submissionUuid, 'failed', 1],
      [second.submissionUuid, 'sent', 1],
    ]);
    expect(h.sleeps).toEqual([]);
  });

  it('sends oldest first, one at a time: a waiting item holds back the next', async () => {
    const h = harness([{ status: 503 }, { status: 201 }, { status: 201 }]);
    const first = item();
    const second = item();
    await runTablet(h.options([first, second]));
    expect(h.attempts.map((a) => a.submissionUuid)).toEqual([
      first.submissionUuid,
      first.submissionUuid,
      second.submissionUuid,
    ]);
  });

  it('an item sealed later joins the outbox at its time', async () => {
    const h = harness([]);
    const options = h.options([]);
    const late = item();
    const at = options.now!() + 42_000;
    const done = await runTablet({ ...options, later: [{ at, item: late }] });
    expect(h.sleeps).toEqual([42_000]);
    expect(done[0]).toMatchObject({ submissionUuid: late.submissionUuid, state: 'sent' });
    expect(h.attempts[0]!.startedAt).toBe(at);
  });

  it('builds a PSI lv.2 body whose photos are the five defects, each named by its SHA-256', () => {
    const sealed = fiveDefectSubmission(1000);
    const body = JSON.parse(sealed.json) as {
      findings: { defectId: string }[];
      photos: { defectId: string; part: string; sha256: string }[];
    };
    expect(body.findings.map((f) => f.defectId)).toEqual(sealed.photos.map((p) => p.defectId));
    expect(new Set(body.photos.map((p) => p.defectId)).size).toBe(5);
    for (const [i, p] of sealed.photos.entries()) {
      expect(p.jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect(p.jpeg.length).toBe(1000);
      expect(body.photos[i]).toEqual({
        defectId: p.defectId,
        part: p.part,
        sha256: createHash('sha256').update(p.jpeg).digest('hex'),
      });
    }
  });
});
