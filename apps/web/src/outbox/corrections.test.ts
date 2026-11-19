import { defaultMapping } from '@m100/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fetch } from '../api/client';
import * as repo from '../db/repo';
import { createDb, type CorrectedSubmission, type M100Db, type OutboxRow } from '../db/schema';
import { correctedExport } from '../export/report';
import { createCorrectionChecker } from './corrections';

const NOW = '2026-11-19T03:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

const item = (uuid: string, overrides: Partial<OutboxRow> = {}): OutboxRow => ({
  submissionUuid: uuid,
  po: '0903359388',
  sealedAt: ago(DAY),
  payloadJson: `{"submissionUuid":"${uuid}"}`,
  payloadSha256: 'x',
  authorUsername: 'DEWI CONTOH',
  authorToken: 'token-dewi',
  authorTokenExpiresAt: ago(-20 * DAY),
  state: 'sent',
  attempts: 1,
  nextAttemptAt: ago(DAY),
  lastAttemptAt: ago(DAY),
  problem: null,
  problemErrors: [],
  displayNo: 'M100-000001',
  sentAt: ago(DAY),
  ...overrides,
});

const SUBMISSION: CorrectedSubmission = {
  displayNo: 'M100-000001',
  sealedAt: '2026-11-18T14:32:05.123+07:00',
  inspectionDate: '2026-11-18',
  user: { username: 'DEWI CONTOH', level: 'PSI lv.2' },
  factory: 'F 3',
  cell: 'F3-11',
  po: '0903359999',
  article: 'ART-9',
  model: 'MODEL 9',
  destination: 'USA',
  orderQty: 50,
  partial: null,
  countingRule: 'ADR-008',
  photoRule: 'ALL',
  counts: { rework: 2, bGrade: 0, reworkApproved: 1, noDefect: 17 },
  findings: [
    {
      inspectionType: 'REWORK',
      areaId: 'A03',
      subAreaId: 'SA03L',
      familyId: 'F03',
      defectId: 'D035',
      qty: 2,
      firstRecordedAt: '2026-11-18T14:05:11.000+07:00',
      defectName: 'x',
      severity: 'MINOR',
    },
  ],
};

/**
 * jsdom's Blob cannot be read, so a photo's "SHA-256" in this test is its size: `blobOf('kept')` is 4 bytes and
 * hashes to `'kept'` through the table below.
 */
const SIZES: Record<string, number> = { kept: 4, new: 3, r1: 2, r2: 5, 'other bytes': 11 };
const NAMES = new Map(Object.entries(SIZES).map(([k, v]) => [v, k]));
const fakeHash = (blob: Blob) => Promise.resolve(NAMES.get(blob.size) ?? '?');
const blobOf = (sha: string) => new Blob(['x'.repeat(SIZES[sha]!)], { type: 'image/jpeg' });

/** A minimal answer: jsdom's `Response` cannot carry a jsdom `Blob`. */
const photoResponse = (blob: Blob) =>
  ({
    ok: true,
    status: 200,
    headers: new Headers(),
    blob: () => Promise.resolve(blob),
  }) as unknown as Response;

let db: M100Db;
let requests: string[];

function api(answers: Record<string, unknown>, photos: Record<string, string> = {}): Fetch {
  return (input) => {
    requests.push(input);
    if (input.includes('/photos/')) {
      const key = Object.keys(photos).find((k) => input.endsWith(k));
      if (!key) {
        return Promise.resolve(
          new Response(JSON.stringify({ code: 'NOT_FOUND', detail: 'Foto tidak ditemukan.' }), {
            status: 404,
            headers: { 'Content-Type': 'application/problem+json' },
          }),
        );
      }
      return Promise.resolve(photoResponse(blobOf(photos[key]!)));
    }
    const ids = new URL(`http://x${input}`).searchParams.get('ids')!.split(',');
    const items = ids.flatMap((id) => (answers[id] ? [answers[id]] : []));
    return Promise.resolve(Response.json({ items }));
  };
}

const answer = (
  uuid: string,
  revisionNo: number,
  photos: { defectId: string; sha256: string }[],
) => ({
  submissionUuid: uuid,
  revisionNo,
  correctedAt: '2026-11-19T02:00:00.000Z',
  reason: 'NO DEFECT terhitung satu kali terlalu banyak',
  submission: SUBMISSION,
  photos: photos.map((p) => ({ ...p, sizeBytes: 10 })),
});

function checker(fetch: Fetch) {
  return createCorrectionChecker({
    db,
    deviceKey: () => 'device-key',
    fetch,
    now: () => NOW,
    sha256: fakeHash,
  });
}

beforeEach(() => {
  db = createDb(`corrections-${crypto.randomUUID()}`);
  requests = [];
});
afterEach(async () => {
  await db.delete();
});

describe('the correction check (ADR-024, doc 03 §4.11)', () => {
  it('asks per author for the sent items only and stores a correction with only the photos it lacks', async () => {
    await repo.putOutboxItem(db, item('u1'));
    await repo.putOutboxItem(db, item('u2', { state: 'waiting', sentAt: null }));
    await repo.putOutboxItem(
      db,
      item('u3', { authorUsername: 'ANDI CONTOH', authorToken: 'token-andi' }),
    );
    await repo.putOutboxItem(db, item('u4', { sentAt: ago(8 * DAY) }));
    await db.outboxPhotos.put({
      submissionUuid: 'u1',
      defectId: 'D049',
      blob: blobOf('kept'),
      sha256: 'kept',
      takenAt: NOW,
    });
    const before = await db.outbox.get('u1');

    await checker(
      api(
        {
          u1: answer('u1', 1, [
            { defectId: 'D035', sha256: 'new' },
            { defectId: 'D049', sha256: 'kept' },
          ]),
        },
        { '/u1/corrections/1/photos/D035': 'new' },
      ),
    ).check();

    expect(requests.filter((r) => r.includes('/corrections?ids='))).toEqual([
      '/v1/submissions/corrections?ids=u1',
      '/v1/submissions/corrections?ids=u3',
    ]);
    expect(requests.filter((r) => r.includes('/photos/'))).toEqual([
      '/v1/submissions/u1/corrections/1/photos/D035',
    ]);
    expect(await repo.getCorrection(db, 'u1')).toMatchObject({
      revisionNo: 1,
      authorUsername: 'DEWI CONTOH',
    });
    expect((await repo.listCorrectionPhotos(db, 'u1')).map((p) => p.sha256)).toEqual(['new']);
    // The outbox item is untouched, byte for byte.
    expect(await db.outbox.get('u1')).toEqual(before);
  });

  it('stores nothing when a photo is missing or its SHA-256 differs, and tries again next time', async () => {
    await repo.putOutboxItem(db, item('u1'));
    await checker(api({ u1: answer('u1', 1, [{ defectId: 'D035', sha256: 'new' }]) })).check();
    expect(await repo.getCorrection(db, 'u1')).toBeUndefined();

    await checker(
      api(
        { u1: answer('u1', 1, [{ defectId: 'D035', sha256: 'new' }]) },
        {
          '/u1/corrections/1/photos/D035': 'other bytes',
        },
      ),
    ).check();
    expect(await repo.getCorrection(db, 'u1')).toBeUndefined();
    expect(await repo.listCorrectionPhotos(db, 'u1')).toEqual([]);
  });

  it('downloads a correction once; a newer revision replaces it', async () => {
    await repo.putOutboxItem(db, item('u1'));
    const first = answer('u1', 1, [{ defectId: 'D035', sha256: 'r1' }]);
    await checker(api({ u1: first }, { '/u1/corrections/1/photos/D035': 'r1' })).check();
    requests = [];
    await checker(api({ u1: first }, { '/u1/corrections/1/photos/D035': 'r1' })).check();
    expect(requests.filter((r) => r.includes('/photos/'))).toEqual([]);

    await checker(
      api(
        { u1: answer('u1', 2, [{ defectId: 'D035', sha256: 'r2' }]) },
        {
          '/u1/corrections/2/photos/D035': 'r2',
        },
      ),
    ).check();
    expect((await repo.getCorrection(db, 'u1'))?.revisionNo).toBe(2);
    expect((await repo.listCorrectionPhotos(db, 'u1')).map((p) => p.sha256)).toEqual(['r2']);
  });

  it('asks for at most 50 ids at a time', async () => {
    for (let i = 0; i < 51; i++)
      await repo.putOutboxItem(db, item(`u${String(i).padStart(2, '0')}`));
    await checker(api({})).check();
    const asks = requests.filter((r) => r.includes('/corrections?ids='));
    expect(asks.map((r) => r.split('ids=')[1]!.split(',').length)).toEqual([50, 1]);
  });

  it('a correction leaves the tablet with its outbox item after 7 days', async () => {
    await repo.putOutboxItem(db, item('u1'));
    await checker(
      api(
        { u1: answer('u1', 1, [{ defectId: 'D035', sha256: 'r1' }]) },
        {
          '/u1/corrections/1/photos/D035': 'r1',
        },
      ),
    ).check();
    expect(
      await repo.purgeSentOutbox(db, new Date(Date.parse(NOW) + 7 * DAY).toISOString()),
    ).toEqual(['u1']);
    expect(await repo.getCorrection(db, 'u1')).toBeUndefined();
    expect(await repo.listCorrectionPhotos(db, 'u1')).toEqual([]);
  });
});

describe('correctedExport (AC-12.5)', () => {
  it('uses the corrected figures, PO, cell, photos and date, and names the revision', () => {
    // The kept photo is the sealed submission's, found by its SHA-256.
    const kept = blobOf('kept');
    const correction = {
      submissionUuid: 'u1',
      authorUsername: 'DEWI CONTOH',
      revisionNo: 3,
      correctedAt: '2026-11-19T02:00:00.000Z',
      reason: 'x',
      submission: SUBMISSION,
      photos: [{ defectId: 'D035' as const, sha256: 'kept' }],
      checkedAt: NOW,
    };
    const report = correctedExport({
      correction,
      mapping: defaultMapping(),
      correctionPhotos: [],
      outboxPhotos: [{ defectId: 'D035', blob: kept, sha256: 'kept' }],
    });
    expect(report.fileBase).toBe('PSI_0903359999_20261118');
    expect(report.correction).toEqual({ revisionNo: 3, correctedAt: '2026-11-19T02:00:00.000Z' });
    expect(report.info).toEqual(
      expect.arrayContaining([
        ['FACTORY/CELL', 'F3-11'],
        ['MODEL', 'MODEL 9'],
      ]),
    );
    // 2 REWORK + 17 NO DEFECT (ADR-008): Qty Inspection 19, A-Grade 17.
    expect(report.results).toEqual(
      expect.arrayContaining([
        { label: 'Qty PO Order', kind: 'count', value: 50 },
        { label: 'Qty Inspection', kind: 'count', value: 19 },
        { label: 'Qty A-Grade', kind: 'count', value: 17 },
        { label: 'REWORK AND APPROVED', kind: 'count', value: 1 },
      ]),
    );
    expect(report.photos.map((p) => p.defectId)).toEqual(['D035']);
    expect(report.photos[0]!.blob).toBe(kept);
  });
});
