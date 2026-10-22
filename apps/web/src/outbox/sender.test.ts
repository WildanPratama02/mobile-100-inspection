import type { SubmissionRequest } from '@m100/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fetch } from '../api/client';
import * as repo from '../db/repo';
import { createDb, type M100Db, type OutboxRow } from '../db/schema';
import { OfflineError } from '../data/sources';
import {
  BACKOFF_MS,
  createOutboxSender,
  NOT_REGISTERED,
  submissionForm,
  type OutboxSenderDeps,
} from './sender';

const SEALED = '2026-10-16T07:32:05.123Z';
const T0 = '2026-10-16T07:32:06.000Z';
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

const payload = (uuid: string, photos: string[] = []): SubmissionRequest => ({
  submissionUuid: uuid,
  sealedAt: '2026-10-16T14:32:05.123+07:00',
  appVersion: '0.0.0',
  user: { username: 'AZIZAH', level: 'PSI lv.2' },
  factory: 'F 3',
  cell: 'F3-10',
  po: '0903359388',
  partial: null,
  counts: { rework: 1, bGrade: 1, noDefect: 1 },
  findings: [
    {
      inspectionType: 'REWORK',
      areaId: 'A03',
      subAreaId: 'SA03L',
      familyId: 'F03',
      defectId: 'D035',
      qty: 2,
      firstRecordedAt: '2026-10-16T14:05:11.000+07:00',
    },
  ],
  photos: photos.map((defectId) => ({
    defectId: defectId as 'D035',
    part: `photo_${defectId}`,
    sha256: `sha-${defectId}`,
  })),
});

const item = (uuid: string, overrides: Partial<OutboxRow> = {}): OutboxRow => ({
  submissionUuid: uuid,
  po: '0903359388',
  sealedAt: SEALED,
  // Non-ASCII on purpose: the bytes sent must be the stored string's UTF-8, unchanged.
  payloadJson: JSON.stringify({ ...payload(uuid), note: 'Ünïcödé ✓' }),
  payloadSha256: 'x',
  authorUsername: 'AZIZAH',
  authorToken: 'token-azizah',
  authorTokenExpiresAt: at(20 * DAY),
  state: 'waiting',
  attempts: 0,
  nextAttemptAt: SEALED,
  lastAttemptAt: null,
  problem: null,
  problemErrors: [],
  displayNo: null,
  sentAt: null,
  ...overrides,
});

/** What one request carried. */
interface Sent {
  url: string;
  token: string | null;
  deviceKey: string | null;
  submission: string;
  submissionType: string;
  photos: Record<string, { type: string; name: string; text: string }>;
}

function readText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(blob);
  });
}

async function describeRequest(url: string, init: RequestInit): Promise<Sent> {
  const headers = new Headers(init.headers);
  const form = init.body as FormData;
  const submission = form.get('submission') as Blob;
  const photos: Sent['photos'] = {};
  for (const [name, value] of form.entries()) {
    if (name === 'submission') continue;
    const file = value as File;
    photos[name] = { type: file.type, name: file.name, text: await readText(file) };
  }
  return {
    url,
    token: headers.get('Authorization')?.replace(/^Bearer /, '') ?? null,
    deviceKey: headers.get('X-Device-Key'),
    submission: await readText(submission),
    submissionType: submission.type,
    photos,
  };
}

type Answer = Response | Error | (() => Promise<Response>);

const problem = (status: number, body: object, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/problem+json', ...headers },
  });

const written = (status: 200 | 201, displayNo = 'M100-000042') =>
  Response.json(
    {
      status: 'written',
      displayNo,
      totals: { qtyInspection: 3, qtyAGrade: 1, qtyBGrade: 0, qtyDefect: 2 },
    },
    { status },
  );

let db: M100Db;
let clock: string;
let requests: Sent[];
let answers: Answer[];
let refresh: ReturnType<typeof vi.fn<OutboxSenderDeps['refresh']>>;
let onChange: ReturnType<typeof vi.fn<() => void>>;

const fetchImpl: Fetch = async (url, init) => {
  requests.push(await describeRequest(url, init));
  const answer = answers.shift();
  if (!answer) throw new Error('No answer scripted');
  if (answer instanceof Error) throw answer;
  return typeof answer === 'function' ? answer() : answer;
};

function sender(deviceKey: string | null = 'device-key') {
  return createOutboxSender({
    db,
    deviceKey: () => deviceKey,
    refresh,
    fetch: fetchImpl,
    now: () => clock,
    onChange,
  });
}

const stored = async (uuid = 'u1') => (await repo.getOutboxItem(db, uuid))!;

beforeEach(async () => {
  db = createDb(`sender-${crypto.randomUUID()}`);
  await db.open();
  clock = T0;
  requests = [];
  answers = [];
  refresh = vi.fn<OutboxSenderDeps['refresh']>(() =>
    Promise.resolve({ token: 'token-renewed', tokenExpiresAt: at(30 * DAY) }),
  );
  onChange = vi.fn<() => void>();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
});

describe('the request (doc 04 §4.1)', () => {
  it('posts the stored JSON byte for byte and one JPEG part per photo, with the device key and the author token', async () => {
    const json = JSON.stringify({ ...payload('u1', ['D035', 'D082']), note: 'Ünïcödé ✓' });
    await repo.putOutboxItem(db, item('u1', { payloadJson: json }));
    for (const defectId of ['D082', 'D035'] as const) {
      await db.outboxPhotos.add({
        submissionUuid: 'u1',
        defectId,
        blob: new Blob([`jpeg-${defectId}`], { type: 'image/jpeg' }),
        sha256: `sha-${defectId}`,
        takenAt: SEALED,
      });
    }
    answers.push(written(201));
    await sender().run();

    expect(requests).toHaveLength(1);
    const [sent] = requests;
    expect(sent).toMatchObject({
      url: '/v1/submissions',
      token: 'token-azizah',
      deviceKey: 'device-key',
      submission: json,
      submissionType: 'application/json',
    });
    // The bytes of each photo are checked on `submissionForm` below: fake-indexeddb hands back no jsdom Blob.
    expect(sent!.photos).toMatchObject({
      photo_D035: { type: 'image/jpeg', name: 'D035.jpg' },
      photo_D082: { type: 'image/jpeg', name: 'D082.jpg' },
    });
    expect(Object.keys(sent!.photos)).toEqual(['photo_D035', 'photo_D082']);
  });

  it('submissionForm: the JSON part, then the photo of each photos[] entry with its bytes', async () => {
    const json = JSON.stringify(payload('u1', ['D035', 'D082']));
    const form = submissionForm({ payloadJson: json }, [
      { defectId: 'D082', blob: new Blob(['jpeg-D082'], { type: 'image/jpeg' }) },
      { defectId: 'D035', blob: new Blob(['jpeg-D035'], { type: 'image/jpeg' }) },
      // Not named by the submission: not sent.
      { defectId: 'D001', blob: new Blob(['jpeg-D001'], { type: 'image/jpeg' }) },
    ]);
    expect([...form.keys()]).toEqual(['submission', 'photo_D035', 'photo_D082']);
    expect(await readText(form.get('submission') as Blob)).toBe(json);
    expect(await readText(form.get('photo_D035') as Blob)).toBe('jpeg-D035');
    expect(await readText(form.get('photo_D082') as Blob)).toBe('jpeg-D082');
  });

  it('sends nothing without a device key', async () => {
    await repo.putOutboxItem(db, item('u1'));
    await sender(null).run({ force: true });
    expect(requests).toEqual([]);
    expect((await stored()).state).toBe('waiting');
  });
});

describe('each answer of doc 04 §5', () => {
  it.each([201, 200] as const)('%i → Terkirim with displayNo', async (status) => {
    await repo.putOutboxItem(db, item('u1'));
    answers.push(written(status));
    await sender().run();
    expect(await stored()).toMatchObject({
      state: 'sent',
      displayNo: 'M100-000042',
      sentAt: T0,
      attempts: 1,
      lastAttemptAt: T0,
      problem: null,
    });
    expect(onChange).toHaveBeenCalled();
  });

  it('logs totals that differ from what the tablet showed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await repo.putOutboxItem(db, item('u1'));
    answers.push(
      Response.json(
        {
          displayNo: 'M100-000001',
          totals: { qtyInspection: 3, qtyAGrade: 1, qtyBGrade: 0, qtyDefect: 9 },
        },
        { status: 201 },
      ),
    );
    await sender().run();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('qtyDefect'));
    expect((await stored()).state).toBe('sent');
  });

  it('401 TOKEN_EXPIRED → renews the author token and resends once', async () => {
    await repo.putOutboxItem(db, item('u1'));
    answers.push(problem(401, { code: 'TOKEN_EXPIRED' }), written(201));
    await sender().run();
    expect(refresh).toHaveBeenCalledWith('token-azizah');
    expect(requests.map((r) => r.token)).toEqual(['token-azizah', 'token-renewed']);
    expect(requests[1]!.submission).toBe(requests[0]!.submission);
    expect(await stored()).toMatchObject({
      state: 'sent',
      authorToken: 'token-renewed',
      authorTokenExpiresAt: at(30 * DAY),
      attempts: 1,
    });
  });

  it('401 TOKEN_EXPIRED again after the resend → Menunggu, not a third request', async () => {
    await repo.putOutboxItem(db, item('u1'));
    answers.push(problem(401, { code: 'TOKEN_EXPIRED' }), problem(401, { code: 'TOKEN_EXPIRED' }));
    await sender().run();
    expect(requests).toHaveLength(2);
    expect(await stored()).toMatchObject({ state: 'waiting', nextAttemptAt: at(BACKOFF_MS[0]) });
  });

  it('401 TOKEN_EXPIRED and the renewal finds no connection → Menunggu', async () => {
    await repo.putOutboxItem(db, item('u1'));
    refresh.mockRejectedValueOnce(new OfflineError());
    answers.push(problem(401, { code: 'TOKEN_EXPIRED' }));
    await sender().run();
    expect(requests).toHaveLength(1);
    expect((await stored()).state).toBe('waiting');
  });

  it.each(['DEVICE_KEY_INVALID', 'TOKEN_INVALID'])(
    '401 %s → Gagal "Tablet belum terdaftar, hubungi admin", never resent',
    async (code) => {
      await repo.putOutboxItem(db, item('u1'));
      answers.push(problem(401, { code, detail: 'x' }));
      const s = sender();
      await s.run();
      expect(await stored()).toMatchObject({ state: 'failed', problem: NOT_REGISTERED });
      await s.run({ force: true });
      expect(requests).toHaveLength(1);
    },
  );

  it.each([
    [
      409,
      'SUBMISSION_UUID_REUSED',
      'Data kiriman berbeda dengan kiriman sebelumnya. Hubungi admin.',
    ],
    [413, 'PAYLOAD_TOO_LARGE', 'Ukuran foto terlalu besar.'],
    [422, 'PHOTO_MISSING', 'Foto wajib untuk: D035'],
  ])(
    '%i %s → Gagal with detail and errors, kept, never resent (AC-11.4)',
    async (status, code, detail) => {
      await repo.putOutboxItem(db, item('u1'));
      answers.push(
        problem(status, {
          code,
          detail,
          errors: [{ path: 'photos', code, message: 'Foto D035 tidak ada.' }],
        }),
      );
      const s = sender();
      await s.run();
      expect(await stored()).toMatchObject({
        state: 'failed',
        problem: detail,
        problemErrors: ['Foto D035 tidak ada.'],
        attempts: 1,
      });
      clock = at(DAY * 30);
      await s.start();
      await s.run({ force: true });
      expect(requests).toHaveLength(1);
      expect(await stored()).toMatchObject({ state: 'failed' });
    },
  );

  it('429 → Menunggu until Retry-After', async () => {
    await repo.putOutboxItem(db, item('u1'));
    answers.push(problem(429, { code: 'RATE_LIMITED' }, { 'Retry-After': '42' }));
    await sender().run();
    expect(await stored()).toMatchObject({ state: 'waiting', nextAttemptAt: at(42_000) });
  });

  it.each([
    [
      '503 SUBMIT_DISABLED',
      () => problem(503, { code: 'SUBMIT_DISABLED' }, { 'Retry-After': '30' }),
      30_000,
    ],
    [
      '503 DB_UNAVAILABLE without Retry-After',
      () => problem(503, { code: 'DB_UNAVAILABLE' }),
      BACKOFF_MS[0],
    ],
    ['500 INTERNAL', () => problem(500, { code: 'INTERNAL' }), BACKOFF_MS[0]],
    [
      '502 from the proxy, not problem+json',
      () => new Response('Bad Gateway', { status: 502 }),
      BACKOFF_MS[0],
    ],
    ['no connection', () => new TypeError('Failed to fetch'), BACKOFF_MS[0]],
    [
      'a timeout',
      () => new DOMException('The operation timed out.', 'TimeoutError'),
      BACKOFF_MS[0],
    ],
  ] as const)('%s → Menunggu with its wait', async (_name, answer, wait) => {
    await repo.putOutboxItem(db, item('u1'));
    answers.push(answer());
    await sender().run();
    expect(await stored()).toMatchObject({
      state: 'waiting',
      attempts: 1,
      lastAttemptAt: T0,
      nextAttemptAt: at(wait),
    });
  });

  it('a timeout, then the resend of the same bytes is answered 200', async () => {
    await repo.putOutboxItem(db, item('u1'));
    answers.push(new DOMException('The operation timed out.', 'TimeoutError'), written(200));
    const s = sender();
    await s.run();
    expect((await stored()).state).toBe('waiting');
    clock = at(BACKOFF_MS[0]);
    await s.run();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.submission).toBe(requests[0]!.submission);
    expect(requests[1]!.submission).toBe(item('u1').payloadJson);
    expect(await stored()).toMatchObject({ state: 'sent', attempts: 2, displayNo: 'M100-000042' });
  });

  it('app closed while Mengirim → Menunggu at the next start, resent with the same UUID and bytes', async () => {
    await repo.putOutboxItem(
      db,
      item('u1', { state: 'sending', attempts: 1, nextAttemptAt: at(DAY) }),
    );
    answers.push(written(200));
    await sender().start();
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]!.submission)).toMatchObject({ submissionUuid: 'u1' });
    expect(requests[0]!.submission).toBe(item('u1').payloadJson);
    expect(await stored()).toMatchObject({ state: 'sent', attempts: 2 });
  });

  it('marks the item Mengirim while the request is out (AC-11.3)', async () => {
    await repo.putOutboxItem(db, item('u1'));
    let release: (r: Response) => void = () => undefined;
    answers.push(() => new Promise<Response>((resolve) => (release = resolve)));
    const running = sender().run();
    await vi.waitFor(async () => expect((await stored()).state).toBe('sending'));
    release(written(201));
    await running;
    expect((await stored()).state).toBe('sent');
  });
});

describe('when and in which order', () => {
  it('waits 5 s, 15 s, 1 min, 5 min, then every 5 min', async () => {
    await repo.putOutboxItem(db, item('u1'));
    const s = sender();
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      answers.push(new TypeError('Failed to fetch'));
      await s.run();
      const { nextAttemptAt } = await stored();
      waits.push(Date.parse(nextAttemptAt) - Date.parse(clock));
      // Not yet due: nothing is sent.
      await s.run();
      clock = nextAttemptAt;
    }
    expect(waits).toEqual([5_000, 15_000, 60_000, 300_000, 300_000, 300_000]);
    expect(requests).toHaveLength(6);
  });

  it('force (start, connection back) sends an item whose wait is not over', async () => {
    await repo.putOutboxItem(db, item('u1', { attempts: 4, nextAttemptAt: at(300_000) }));
    const s = sender();
    await s.run();
    expect(requests).toHaveLength(0);
    answers.push(written(201));
    await s.run({ force: true });
    expect((await stored()).state).toBe('sent');
  });

  it('sends the oldest first and stops a pass at the first item without an answer', async () => {
    await repo.putOutboxItem(db, item('newer', { sealedAt: '2026-10-16T07:40:00.000Z' }));
    await repo.putOutboxItem(db, item('older', { sealedAt: '2026-10-16T07:00:00.000Z' }));
    await repo.putOutboxItem(db, item('newest', { sealedAt: '2026-10-16T07:50:00.000Z' }));
    answers.push(written(201), new TypeError('Failed to fetch'));
    await sender().run();
    expect(
      requests.map((r) => (JSON.parse(r.submission) as { submissionUuid: string }).submissionUuid),
    ).toEqual(['older', 'newer']);
    expect((await stored('newest')).attempts).toBe(0);
  });

  it('goes on after a Gagal item', async () => {
    await repo.putOutboxItem(db, item('a', { sealedAt: '2026-10-16T07:00:00.000Z' }));
    await repo.putOutboxItem(db, item('b', { sealedAt: '2026-10-16T07:10:00.000Z' }));
    answers.push(
      problem(422, { code: 'PO_NOT_FOUND', detail: 'PO tidak ditemukan di master PO.' }),
      written(201),
    );
    await sender().run();
    expect((await stored('a')).state).toBe('failed');
    expect((await stored('b')).state).toBe('sent');
  });

  it('sends each item with its own author token, whoever is logged in (doc 03 §4.4)', async () => {
    await repo.putOutboxItem(db, item('a', { authorUsername: 'PSI A', authorToken: 'token-a' }));
    await repo.putOutboxItem(
      db,
      item('b', {
        authorUsername: 'PSI B',
        authorToken: 'token-b',
        sealedAt: '2026-10-16T08:00:00.000Z',
      }),
    );
    answers.push(written(201), written(201, 'M100-000043'));
    await sender().run();
    expect(requests.map((r) => r.token)).toEqual(['token-a', 'token-b']);
  });

  it('renews an author token with fewer than 7 days left before sending', async () => {
    await repo.putOutboxItem(db, item('u1', { authorTokenExpiresAt: at(6 * DAY) }));
    answers.push(written(201));
    await sender().run();
    expect(refresh).toHaveBeenCalledWith('token-azizah');
    expect(requests[0]!.token).toBe('token-renewed');
  });

  it('sends with the old token when the early renewal gets no answer', async () => {
    await repo.putOutboxItem(db, item('u1', { authorTokenExpiresAt: at(6 * DAY) }));
    refresh.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    answers.push(written(201));
    await sender().run();
    expect(requests[0]!.token).toBe('token-azizah');
    expect((await stored()).state).toBe('sent');
  });

  it('send() resolves to the item after its first attempt', async () => {
    await repo.putOutboxItem(db, item('u1'));
    answers.push(written(201));
    expect(await sender().send('u1')).toMatchObject({ state: 'sent', displayNo: 'M100-000042' });
  });

  it('a run asked for during a pass runs once more after it, never two at once', async () => {
    await repo.putOutboxItem(db, item('u1'));
    let release: (r: Response) => void = () => undefined;
    answers.push(() => new Promise<Response>((resolve) => (release = resolve)));
    const s = sender();
    const first = s.run();
    await vi.waitFor(async () => expect((await stored()).state).toBe('sending'));
    await repo.putOutboxItem(db, item('u2', { sealedAt: '2026-10-16T08:00:00.000Z' }));
    answers.push(written(201, 'M100-000043'));
    const second = s.run();
    const third = s.run();
    expect(requests).toHaveLength(1);
    release(written(201));
    await Promise.all([first, second, third]);
    expect(requests).toHaveLength(2);
    expect((await stored('u2')).state).toBe('sent');
  });

  it('removes Terkirim items 7 days after sending', async () => {
    await repo.putOutboxItem(db, item('old', { state: 'sent', sentAt: at(-7 * DAY) }));
    await sender().run();
    expect(await repo.getOutboxItem(db, 'old')).toBeUndefined();
    expect(onChange).toHaveBeenCalled();
  });
});
