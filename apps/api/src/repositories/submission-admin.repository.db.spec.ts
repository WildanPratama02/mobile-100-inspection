import { Database } from '../db/database';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import {
  FINDINGS,
  insertFinding,
  insertPhoto,
  insertSubmission,
  seedMasterData,
  submissionRow,
} from '../testing/schema-fixtures';
import {
  type ExportCursor,
  PgSubmissionAdminRepository,
  type SubmissionFilter,
} from './submission-admin.repository';

let db: TestDatabase;
let repo: PgSubmissionAdminRepository;

/** Ids of the rows below, newest `sealed_at` first: the list order. */
const ids: Record<'late' | 'midnight' | 'evening' | 'other', string> = {
  late: '',
  midnight: '',
  evening: '',
  other: '',
};

beforeAll(async () => {
  db = await createTestDatabase({ migrated: true });
  await db.as('m100_migrate', seedMasterData, { commit: true });
  // 00:30 WIB on 17 Oct, with findings and photos.
  ids.midnight = await insertSubmission(db.client, submissionRow());
  for (const f of FINDINGS) await insertFinding(db.client, ids.midnight, f);
  for (const d of ['D001', 'D002'] as const) await insertPhoto(db.client, ids.midnight, d);
  // 23:59 WIB on 16 Oct: the day before, although only 31 minutes earlier.
  ids.evening = await insertSubmission(
    db.client,
    submissionRow({
      sealed_at: '2026-10-16T16:59:00.000Z',
      inspection_date: '2026-10-16',
      username: 'AZIZAH',
      cell: 'F3-11',
      partial_no: null,
      partial_qty: null,
      photo_count: 0,
    }),
  );
  ids.late = await insertSubmission(
    db.client,
    submissionRow({ sealed_at: '2026-10-18T01:00:00.000Z', inspection_date: '2026-10-18' }),
  );
  ids.other = await insertSubmission(
    db.client,
    submissionRow({
      sealed_at: '2026-10-17T05:00:00.000Z',
      inspection_date: '2026-10-17',
      factory: 'F 4',
      cell: 'F4-01',
      po: 'AB0903359388',
    }),
  );
  repo = new PgSubmissionAdminRepository(new Database(db.pool('m100_app')));
});
afterAll(async () => {
  await db?.drop();
});

const listIds = async (filter: SubmissionFilter) =>
  (await repo.list(filter, { offset: 0, limit: 50 })).map((r) => r.id);

describe('PgSubmissionAdminRepository.list and count', () => {
  it('lists newest sealed first, as m100_app', async () => {
    expect(await listIds({})).toEqual([ids.late, ids.other, ids.midnight, ids.evening]);
    expect(await repo.count({})).toBe(4);
  });

  it('filters on the WIB inspection date, both ends inclusive', async () => {
    expect(await listIds({ from: '2026-10-17', to: '2026-10-17' })).toEqual([
      ids.other,
      ids.midnight,
    ]);
    expect(await listIds({ to: '2026-10-16' })).toEqual([ids.evening]);
    expect(await listIds({ from: '2026-10-18' })).toEqual([ids.late]);
    expect(await repo.count({ from: '2026-10-17' })).toBe(3);
  });

  it('matches factory, cell and username exactly and the PO by part, ignoring case', async () => {
    expect(await listIds({ factory: 'F 4' })).toEqual([ids.other]);
    expect(await listIds({ factory: 'F' })).toEqual([]);
    expect(await listIds({ cell: 'F3-11' })).toEqual([ids.evening]);
    expect(await listIds({ username: 'AZIZAH' })).toEqual([ids.evening]);
    expect(await listIds({ username: 'azizah' })).toEqual([]);
    expect(await listIds({ po: 'ab09' })).toEqual([ids.other]);
    expect(await listIds({ po: '9388' })).toEqual([ids.other]);
    expect(await listIds({ po: '%' })).toEqual([]);
    expect(await listIds({ po: '28839', from: '2026-10-17' })).toEqual([ids.late, ids.midnight]);
  });

  it('pages with offset and limit', async () => {
    const page = await repo.list({}, { offset: 1, limit: 2 });
    expect(page.map((r) => r.id)).toEqual([ids.other, ids.midnight]);
  });

  it('returns the view columns: partial text, raw fractions, dates as text', async () => {
    const row = await repo.findById(ids.midnight);
    expect(row).toMatchObject({
      inspectionDate: '2026-10-17',
      partialText: 'P1 1.200 OF 10.002',
      rft: '0.60000',
      defectRate: '0.36667',
      podd: '2026-01-12',
      crd: null,
      countingRule: 'ADR-008',
      photoCount: 5,
    });
    expect(row!.sealedAt.toISOString()).toBe('2026-10-16T17:30:00.000Z');
    expect(typeof row!.displayNo).toBe('number');
    expect((await repo.findById(ids.evening))!.partialText).toBeNull();
    expect(await repo.findById('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('PgSubmissionAdminRepository findings and photos', () => {
  it('lists findings in first-tap order with the names of area, sub-area and family', async () => {
    const findings = await repo.findings([ids.midnight, ids.evening]);
    expect(findings).toHaveLength(FINDINGS.length);
    const sorted = [...FINDINGS].sort(
      (a, b) => Date.parse(a.firstRecordedAt) - Date.parse(b.firstRecordedAt),
    );
    expect(findings.map((f) => [f.inspectionType, f.areaId, f.defectId])).toEqual(
      sorted.map((f) => [f.inspectionType, f.areaId, f.defectId]),
    );
    expect(findings[0]).toMatchObject({
      areaName: 'TOE',
      subAreaName: 'TOE TIP',
      familyName: 'BONDING',
    });
    expect(await repo.findings([])).toEqual([]);
  });

  it('finds photo rows by submission and by id', async () => {
    const photos = await repo.photos([ids.midnight]);
    expect(photos.map((p) => p.defectId)).toEqual(['D001', 'D002']);
    const one = await repo.photo(photos[0]!.id);
    expect(one).toEqual(photos[0]);
    expect(one!.objectKey).toBe(`submissions/2026/10/${ids.midnight}/D001.jpg`);
    expect(await repo.photo(999_999)).toBeNull();
  });
});

describe('PgSubmissionAdminRepository.exportBatch', () => {
  it('reads the filtered list in batches that continue after the cursor', async () => {
    const seen: string[] = [];
    let cursor: ExportCursor | null = null;
    for (;;) {
      const batch = await repo.exportBatch({}, cursor, 1);
      if (batch.length === 0) break;
      seen.push(...batch.map((r) => r.id));
      cursor = batch.at(-1)!.cursor;
    }
    expect(seen).toEqual(await listIds({}));
  });

  it('applies the filter', async () => {
    const batch = await repo.exportBatch({ from: '2026-10-17', to: '2026-10-17' }, null, 10);
    expect(batch.map((r) => r.id)).toEqual([ids.other, ids.midnight]);
  });
});
