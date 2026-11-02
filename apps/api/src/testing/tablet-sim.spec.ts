/**
 * Unit tests for the load sim (T3.7, T7.8): the outbox simulator `runTablet` must behave like the tablet's outbox
 * of doc 04 §5 (the fault test's "exactly once" relies on it), and the submissions the load and fault tests send in
 * bulk (`psiSubmission`) must be what a new PSI lv.2 tablet seals (ADR-022) and pass the API's own checks: findings
 * and photos one to one, unique parts, JPEG bytes that match their `sha256`, timestamps that parse, `photoRule:
 * 'ALL'` and `counts.reworkApproved`. Cheap compared to a load run.
 */
import { createHash } from 'node:crypto';
import { defaultMapping, type SubmissionRequest } from '@m100/shared';
import { sha256Hex } from '../submissions/multipart';
import {
  checkSubmission,
  type KnownDefect,
  storedPhotoRule,
} from '../submissions/submission-checks';
import { submissionSchema } from '../submissions/submission-schema';
import {
  type Attempt,
  BACKOFF_MS,
  psiSubmission,
  runTablet,
  type SealedSubmission,
  type TabletOptions,
} from './tablet-sim';

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

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

const item = () => psiSubmission(64);

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
});

const mapping = defaultMapping();
const knownDefects = new Map<string, KnownDefect>(
  mapping.defects.map((d) => [d.id, { name: d.name, classification: d.classification }]),
);
const checkContext = {
  orderQty: 1200,
  defects: knownDefects,
  now: new Date('2026-10-16T15:00:00+07:00'),
};

/** The request the API checks: the schema's output with the family from the map row, as the validator builds it. */
function apiRequest(sealed: SealedSubmission): SubmissionRequest {
  const parsed = submissionSchema.parse(JSON.parse(sealed.json));
  return {
    ...parsed,
    findings: parsed.findings.map((f) => ({
      ...f,
      familyId: mapping.map.find((e) => e.defectId === f.defectId)!.familyId,
    })),
  };
}

const partsOf = (sealed: SealedSubmission) => new Map(sealed.photos.map((p) => [p.part, p.jpeg]));

describe("psiSubmission (T7.8, the load and fault tests' builder)", () => {
  it('emits 15 findings with 15 photos when asked for 15 (the LOAD_PHOTOS default)', () => {
    const sealed = psiSubmission(300, 15);
    const body = JSON.parse(sealed.json) as SubmissionRequest;

    expect(body.user).toEqual({ username: 'TEST BUDI', level: 'PSI lv.2' });
    expect(body.findings).toHaveLength(15);
    expect(body.photos).toHaveLength(15);
    expect(sealed.photos).toHaveLength(15);

    // One finding per defect, each photographed at most once, and every photo's defect has its finding.
    const defectIds = body.findings.map((f) => f.defectId);
    expect(new Set(defectIds).size).toBe(15);
    for (const photo of body.photos) {
      expect(defectIds).toContain(photo.defectId);
      expect(photo.part).toBe(`photo_${String(photo.defectId)}`);
    }

    // Every timestamp parses (the build of T7.8 fixed `13:00:0${i + 1}` for i beyond 8).
    for (const finding of body.findings) {
      expect(Number.isFinite(Date.parse(finding.firstRecordedAt))).toBe(true);
    }
    expect(body.findings.at(-1)!.firstRecordedAt).toBe('2026-10-16T13:00:15.250+07:00');
  });

  it('every photo part is a JPEG whose bytes hash to its entry and appears once', () => {
    const sealed = psiSubmission(300, 15);
    const body = JSON.parse(sealed.json) as SubmissionRequest;
    const byPart = partsOf(sealed);

    expect(new Set(byPart.keys()).size).toBe(15);
    for (const photo of body.photos) {
      const jpeg = byPart.get(photo.part)!;
      expect(jpeg.subarray(0, JPEG_SIGNATURE.length)).toEqual(JPEG_SIGNATURE);
      expect(sha256Hex(jpeg)).toBe(photo.sha256);
    }
  });

  it('defaults to the old five-findings, five-photos shape (T3.7)', () => {
    const sealed = psiSubmission(200);
    const body = JSON.parse(sealed.json) as SubmissionRequest;
    expect(body.findings).toHaveLength(5);
    expect(body.photos).toHaveLength(5);
    expect(sealed.photos).toHaveLength(5);
    expect(body.counts.rework).toBe(10);
  });

  it.each([5, 15])(
    'sends what a new PSI lv.2 tablet sends (ADR-022) and passes the API checks under ALL (%i photos)',
    (photoCount) => {
      const sealed = psiSubmission(300, photoCount);
      const body = JSON.parse(sealed.json) as SubmissionRequest;
      expect(body.photoRule).toBe('ALL');
      expect(body.counts).toEqual({ rework: 10, bGrade: 1, reworkApproved: 4, noDefect: 19 });

      const request = apiRequest(sealed);
      expect(storedPhotoRule(request)).toBe('ALL');
      expect(checkSubmission(request, partsOf(sealed), checkContext)).toEqual([]);
    },
  );

  it('the ALL rule is in force: one photo fewer is PHOTO_MISSING, also beyond the Top 5', () => {
    const sealed = psiSubmission(300, 15);
    const body = JSON.parse(sealed.json) as SubmissionRequest;
    const dropped = body.photos.at(-1)!;
    const fewer: SealedSubmission = {
      ...sealed,
      json: JSON.stringify({ ...body, photos: body.photos.slice(0, -1) }),
      photos: sealed.photos.filter((p) => p.part !== dropped.part),
    };
    expect(checkSubmission(apiRequest(fewer), partsOf(fewer), checkContext)).toEqual([
      expect.objectContaining({
        path: 'photos',
        code: 'PHOTO_MISSING',
        message: `Foto wajib untuk ${String(dropped.defectId)}.`,
      }),
    ]);
  });
});
