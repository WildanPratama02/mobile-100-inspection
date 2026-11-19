import { createHash, randomUUID } from 'node:crypto';
import { revisionChanges, versionTotals, type SubmissionVersion } from '@m100/shared';
import { Database } from '../db/database';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import {
  FINDINGS,
  insertAdmin,
  insertFinding,
  insertPhoto,
  insertSubmission,
  seedMasterData,
  submissionRow,
} from '../testing/schema-fixtures';
import { PgSubmissionRepository } from './submission.repository';
import {
  type NewRevision,
  PgSubmissionRevisionRepository,
  RevisionTotalsMismatch,
} from './submission-revision.repository';

let db: TestDatabase;
let app: Database;
let repo: PgSubmissionRevisionRepository;
let adminId: number;
let subId: string;
let otherId: string;

const sha = (text: string): Buffer => createHash('sha256').update(text).digest();

beforeAll(async () => {
  db = await createTestDatabase({ migrated: true });
  await db.as('m100_migrate', seedMasterData, { commit: true });
  await db.as(
    'm100_migrate',
    async (c) => {
      subId = await insertSubmission(c, submissionRow());
      for (const f of FINDINGS) await insertFinding(c, subId, f);
      await insertPhoto(c, subId, 'D001');
      otherId = await insertSubmission(c, submissionRow({ username: 'ANOTHER PSI' }));
      adminId = await insertAdmin(c);
    },
    { commit: true },
  );
  app = new Database(db.pool('m100_app'));
  repo = new PgSubmissionRevisionRepository(app);
});

afterAll(async () => {
  await db?.drop();
});

/** Revision `n` of the submission: NO DEFECT 18 + n, the first two findings, D001's photo replaced. */
function newRevision(
  base: SubmissionVersion,
  n: number,
  overrides: Partial<NewRevision> = {},
): NewRevision {
  const id = overrides.id ?? randomUUID();
  const findings = base.findings.slice(0, 2);
  const version: SubmissionVersion = {
    ...base,
    cell: `F3-1${n}`,
    counts: { rework: 10, bGrade: 2, reworkApproved: n, noDefect: 18 + n },
    findings,
    photos: [{ defectId: 'D001', sha256: sha(`r${n}`).toString('hex') }],
  };
  return {
    id,
    submissionId: subId,
    revisionNo: n,
    requestSha256: sha(`request ${id}`),
    adminId,
    adminUsername: 'qip.digital',
    reason: 'Salah input NO DEFECT oleh PSI',
    version,
    totals: versionTotals(version),
    findings,
    photos: [
      {
        defectId: 'D001',
        objectKey: `submissions/2026/10/${subId}/r${n}/D001.jpg`,
        sha256: sha(`r${n}`),
        sizeBytes: 120_000,
      },
    ],
    changes: revisionChanges(base, version),
    ...overrides,
  };
}

describe('PgSubmissionRevisionRepository (ADR-024, doc 02 §4.4)', () => {
  it('reads the original as revision 0 and as the effective version before any correction', async () => {
    expect(await repo.latestRevisionNo(subId)).toBe(0);
    expect(await repo.latestRevisionNo(randomUUID())).toBeNull();
    const effective = await repo.findVersion(subId);
    const original = await repo.findVersion(subId, 0);
    expect(effective).toEqual(original);
    expect(original).toMatchObject({
      revisionNo: 0,
      latestRevisionNo: 0,
      level: 'PSI lv.2',
      countingRule: 'ADR-008',
      originalUsername: 'ROIS FATHUR ROHIM',
      correctedBy: null,
      version: {
        sealedAt: '2026-10-17T00:30:00.000+07:00',
        cell: 'F3-10',
        partial: { number: 1, qty: 1200 },
        counts: { rework: 10, bGrade: 2, reworkApproved: null, noDefect: 18 },
      },
      totals: { qtyInspection: 30, qtyAGrade: 18, qtyDefect: 11, rft: 0.6 },
    });
    expect(original!.version.findings).toHaveLength(FINDINGS.length);
    expect(original!.version.findings[0]).toMatchObject({
      defectId: 'D001',
      defectName: 'BOND GAP',
      severity: 'MINOR',
      firstRecordedAt: '2026-10-17T00:01:00.000+07:00',
    });
    expect(original!.photos).toEqual([
      expect.objectContaining({ source: 'original', defectId: 'D001' }),
    ]);
    expect(await repo.findVersion(subId, 1)).toBeNull();
  });

  it('writes a revision in a transaction; it becomes the effective version, the original stays', async () => {
    const base = (await repo.findVersion(subId))!.version;
    const revision = newRevision(base, 1);
    const written = await app.transaction(async (tx) => {
      expect(await repo.lockForRevision(subId, tx)).toBe(0);
      return repo.insert(revision, tx);
    });
    expect(written).toBe(true);

    const effective = (await repo.findVersion(subId))!;
    expect(effective).toMatchObject({
      revisionNo: 1,
      latestRevisionNo: 1,
      correctedBy: 'qip.digital',
      correctionReason: 'Salah input NO DEFECT oleh PSI',
      version: { cell: 'F3-11', counts: { noDefect: 19, reworkApproved: 1 } },
      totals: { qtyInspection: 31, qtyAGrade: 19, qtyDefect: 4 },
    });
    expect(effective.version.findings.map((f) => f.defectId)).toEqual(['D001', 'D002']);
    expect(effective.photos).toEqual([
      expect.objectContaining({
        source: 'revision',
        objectKey: `submissions/2026/10/${subId}/r1/D001.jpg`,
      }),
    ]);
    expect((await repo.findVersion(subId, 0))!.version.cell).toBe('F3-10');
    expect((await repo.findVersion(subId, 0))!.latestRevisionNo).toBe(1);

    expect(await repo.findRevision(revision.id)).toEqual({
      id: revision.id,
      submissionId: subId,
      revisionNo: 1,
      requestSha256: revision.requestSha256.toString('hex'),
    });
    // The same id again writes nothing.
    expect(await app.transaction((tx) => repo.insert(revision, tx))).toBe(false);
  });

  it('refuses totals that disagree with the rows and writes nothing', async () => {
    const base = (await repo.findVersion(subId))!.version;
    const revision = newRevision(base, 2);
    revision.totals = { ...revision.totals, qtyDefect: revision.totals.qtyDefect + 1 };
    await expect(app.transaction((tx) => repo.insert(revision, tx))).rejects.toBeInstanceOf(
      // The database check (qty_b_grade <= qty_defect) passes; the re-check does not.
      RevisionTotalsMismatch,
    );
    expect(await repo.latestRevisionNo(subId)).toBe(1);
  });

  it('lists the history: revision 0 by the PSI, then each correction with its changes', async () => {
    const history = await repo.history(subId);
    expect(history.map((h) => [h.revisionNo, h.by, h.reason])).toEqual([
      [0, 'ROIS FATHUR ROHIM', null],
      [1, 'qip.digital', 'Salah input NO DEFECT oleh PSI'],
    ]);
    expect(history[1]!.changes!.fields).toEqual(
      expect.arrayContaining([{ field: 'cell', old: 'F3-10', new: 'F3-11' }]),
    );
  });

  it('gives the tablet only its own corrected submissions and the photos of the newest revision', async () => {
    const found = await repo.newestFor([subId, otherId, randomUUID()], 'ROIS FATHUR ROHIM');
    expect(found.map((r) => [r.submissionId, r.revisionNo])).toEqual([[subId, 1]]);
    expect(await repo.newestFor([subId], 'ANOTHER PSI')).toEqual([]);
    expect(await repo.newestFor([otherId], 'ANOTHER PSI')).toEqual([]); // not corrected

    expect(await repo.correctionPhoto(subId, 1, 'D001', 'ROIS FATHUR ROHIM')).toMatchObject({
      objectKey: `submissions/2026/10/${subId}/r1/D001.jpg`,
    });
    expect(await repo.correctionPhoto(subId, 1, 'D001', 'ANOTHER PSI')).toBeNull();
    expect(await repo.correctionPhoto(subId, 0, 'D001', 'ROIS FATHUR ROHIM')).toBeNull();
    expect(await repo.correctionPhoto(subId, 1, 'D002', 'ROIS FATHUR ROHIM')).toBeNull();
  });

  it('reads a revision photo by id; the sweep counts its key as in use', async () => {
    const photo = (await repo.findVersion(subId))!.photos[0]!;
    expect(await repo.revisionPhoto(photo.id)).toEqual(photo);
    expect(await repo.revisionPhoto(999_999)).toBeNull();
    const key = `submissions/2026/10/${subId}/r1/D001.jpg`;
    const original = `submissions/2026/10/${subId}/D001.jpg`;
    expect(
      await new PgSubmissionRepository(app).photoKeysInUse([key, original, 'submissions/x.jpg']),
    ).toEqual(new Set([key, original]));
  });
});
