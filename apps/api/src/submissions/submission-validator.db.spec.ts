import {
  defaultMapping,
  type DefectId,
  type Finding,
  type InspectionType,
  type SubmissionRequest,
} from '@m100/shared';
import type { TabletClaims } from '../auth/tablet-token';
import { Database } from '../db/database';
import { ApiProblem, type ProblemBody } from '../errors/problem';
import { importMaster, pgImportRepositories } from '../import/import-master';
import { parseMaster } from '../import/parse-master';
import { PgMasterDataRepository } from '../repositories/master-data.repository';
import { PgPoRepository } from '../repositories/po.repository';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { fixtureTables } from '../testing/master-fixtures';
import { expectMatchesSchema } from '../testing/openapi';
import { sha256Hex, type SubmissionParts } from './multipart';
import { SubmissionValidator } from './submission-validator';

const mapping = defaultMapping();
const NOW = new Date('2026-10-16T07:40:00.000Z');
const DEVICE = '9b0f9d6e-1c1a-4f57-9d55-3c1f2b6a7e01';
const BUDI: TabletClaims = {
  sub: 'TEST BUDI',
  lvl: 'PSI lv.2',
  fac: 'F 1',
  cel: 'F1-1',
  dev: DEVICE,
};
const ANDI: TabletClaims = {
  sub: 'TEST ANDI',
  lvl: 'PSI lv.1',
  fac: 'F 1',
  cel: 'F1-1',
  dev: DEVICE,
};

let testDb: TestDatabase;
let db: Database;
let validator: SubmissionValidator;

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: true });
  db = new Database(testDb.pool('m100_app'));
  await importMaster(db, pgImportRepositories(db), parseMaster(await fixtureTables()), {
    dryRun: false,
  });
  validator = new SubmissionValidator(db, new PgMasterDataRepository(db), new PgPoRepository(db));
});

afterAll(async () => {
  await testDb?.drop();
});

/** A finding on the defect's first map row; `familyId` is left out, as the contract allows. */
function finding(
  defectId: DefectId,
  qty: number,
  inspectionType: InspectionType = 'REWORK',
  second = 1,
): Omit<Finding, 'familyId'> {
  const entry = mapping.map.find((e) => e.defectId === defectId);
  if (!entry) throw new Error(`No map entry for ${defectId}`);
  return {
    inspectionType,
    areaId: entry.areaId,
    subAreaId: entry.subAreaId,
    defectId,
    qty,
    firstRecordedAt: `2026-10-16T13:00:${String(second).padStart(2, '0')}.250+07:00`,
  };
}

const jpeg = (seed: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(seed)]);

type Body = Omit<SubmissionRequest, 'findings'> & { findings: Omit<Finding, 'familyId'>[] };

/** The doc 02 §9 example: 10 REWORK pairs with 8 defects, 2 B-GRADE pairs with 3, 18 NO DEFECT. */
function body(overrides: Partial<Body> = {}): Body {
  return {
    submissionUuid: '0f6b6c1e-6a52-4c9f-9a3e-5d7a2b0c41f2',
    sealedAt: '2026-10-16T14:32:05.123+07:00',
    appVersion: '1.0.0',
    user: { username: 'TEST BUDI', level: 'PSI lv.2' },
    factory: 'F 1',
    cell: 'F1-1',
    po: '0902028839',
    partial: { number: 1, qty: 12 },
    counts: { rework: 10, bGrade: 2, noDefect: 18 },
    findings: [
      finding('D035', 5),
      finding('D049', 3, 'REWORK', 2),
      finding('D082', 3, 'B-GRADE', 3),
    ],
    photos: [],
    ...overrides,
  };
}

/** The parts as the parser hands them over, with one photo per defect in `photoIds`. */
function parts(b: Body | Record<string, unknown>, photoIds: DefectId[] = []): SubmissionParts {
  const photos = new Map(photoIds.map((id) => [`photo_${id}`, jpeg(id)]));
  const withPhotos =
    photoIds.length === 0
      ? b
      : {
          ...b,
          photos: photoIds.map((id) => ({
            defectId: id,
            part: `photo_${id}`,
            sha256: sha256Hex(photos.get(`photo_${id}`) as Buffer),
          })),
        };
  const json = Buffer.from(JSON.stringify(withPhotos));
  return { json, payloadSha256: sha256Hex(json), body: JSON.parse(json.toString()), photos };
}

const TOP: DefectId[] = ['D035', 'D049', 'D082'];

/** The problem `validate` was refused with, checked against the `Problem` schema of the contract. */
async function refusal(promise: Promise<unknown>): Promise<ProblemBody> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof ApiProblem)) throw error;
    expectMatchesSchema(error.body, '#/components/schemas/Problem');
    expect(error.getStatus()).toBe(error.body.status);
    return error.body;
  }
  throw new Error('Expected the request to be refused');
}

const paths = (p: ProblemBody) => p.errors?.map((e) => [e.path, e.code]);

describe('SubmissionValidator (doc 04 §4.2)', () => {
  it('accepts the doc 02 §9 example from PSI lv.2 with its Top 5 photos, and computes the totals', async () => {
    const input = parts(body(), TOP);
    expectMatchesSchema(input.body, '#/components/schemas/SubmissionRequest');
    const valid = await validator.validate(input, BUDI, NOW);
    expect(valid.totals).toMatchObject({
      qtyInspection: 30,
      qtyAGrade: 18,
      qtyBGrade: 3,
      qtyDefect: 11,
    });
    expect(valid.totals.passRate).toBeCloseTo(0.6, 5);
    expect(valid.totals.defectRate).toBeCloseTo(11 / 30, 5);
    expect(valid.payloadSha256).toBe(sha256Hex(input.json));
    expect(valid.photos.map((p) => [p.defectId, p.size])).toEqual(
      TOP.map((id) => [id, jpeg(id).length]),
    );
    // The family comes from the map row.
    expect(valid.request.findings.map((f) => f.familyId)).toEqual(
      valid.request.findings.map(
        (f) =>
          mapping.map.find((e) => e.subAreaId === f.subAreaId && e.defectId === f.defectId)
            ?.familyId,
      ),
    );
  });

  it('accepts PSI lv.1 without photos', async () => {
    const lv1 = body({ user: { username: 'TEST ANDI', level: 'PSI lv.1' } });
    await expect(validator.validate(parts(lv1), ANDI, NOW)).resolves.toMatchObject({ photos: [] });
  });

  it('validates in one read-only REPEATABLE READ transaction (doc 02 §6.1 step 2)', async () => {
    const spy = jest.spyOn(db, 'transaction');
    await validator.validate(parts(body(), TOP), BUDI, NOW);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), {
      isolation: 'REPEATABLE READ',
      readOnly: true,
    });
    spy.mockRestore();
  });

  describe('rule 1: user, factory and cell', () => {
    it('refuses a PSI other than the token’s with USER_NOT_FOUND', async () => {
      const problem = await refusal(
        validator.validate(parts(body()), { ...BUDI, sub: 'TEST DEWI' }, NOW),
      );
      expect(problem).toMatchObject({
        status: 422,
        code: 'USER_NOT_FOUND',
        detail: 'Nama tidak ada di daftar PSI.',
      });
      expect(paths(problem)).toEqual([['user', 'USER_NOT_FOUND']]);
    });

    it('refuses a deactivated PSI with USER_NOT_FOUND', async () => {
      await testDb.client.query(
        `UPDATE psi_users SET active = false WHERE username = 'TEST DEWI' AND level = 'PSI lv.2'`,
      );
      const dewi = body({ user: { username: 'TEST DEWI', level: 'PSI lv.2' } });
      const problem = await refusal(
        validator.validate(parts(dewi, TOP), { ...BUDI, sub: 'TEST DEWI' }, NOW),
      );
      expect(problem.code).toBe('USER_NOT_FOUND');
    });

    it('refuses a cell other than the token’s, or a deactivated one, with CELL_NOT_FOUND', async () => {
      const other = await refusal(
        validator.validate(parts(body(), TOP), { ...BUDI, cel: 'F1-2' }, NOW),
      );
      expect(other).toMatchObject({
        code: 'CELL_NOT_FOUND',
        detail: 'Factory/Cell tidak ditemukan.',
      });

      await testDb.client.query(`UPDATE cells SET active = false WHERE code = 'F1-2'`);
      const inactive = await refusal(
        validator.validate(parts(body({ cell: 'F1-2' }), TOP), { ...BUDI, cel: 'F1-2' }, NOW),
      );
      expect(paths(inactive)).toEqual([['cell', 'CELL_NOT_FOUND']]);
    });
  });

  it('rule 2: refuses an unknown PO with PO_NOT_FOUND as 422', async () => {
    const problem = await refusal(
      validator.validate(parts(body({ po: '0000000000' }), TOP), BUDI, NOW),
    );
    expect(problem).toMatchObject({ status: 422, code: 'PO_NOT_FOUND' });
  });

  it('rule 6: refuses a partial quantity above the PO’s ORDER QTY (17)', async () => {
    const problem = await refusal(
      validator.validate(parts(body({ partial: { number: 1, qty: 18 } }), TOP), BUDI, NOW),
    );
    expect(paths(problem)).toEqual([['partial.qty', 'INVALID']]);
  });

  describe('rule 4: findings against the master data', () => {
    it('refuses a defect that does not exist', async () => {
      const b = body({ findings: [{ ...finding('D035', 1), defectId: 'D099' }] });
      expect(paths(await refusal(validator.validate(parts(b), BUDI, NOW)))).toEqual([
        ['findings[0].defectId', 'INVALID'],
      ]);
    });

    it('refuses a sub-area of another area', async () => {
      const f = finding('D035', 1);
      const elsewhere = mapping.map.find((e) => e.areaId !== f.areaId);
      const b = body({ findings: [{ ...f, subAreaId: elsewhere!.subAreaId }] });
      expect(paths(await refusal(validator.validate(parts(b, ['D035']), BUDI, NOW)))).toEqual([
        ['findings[0].subAreaId', 'INVALID'],
      ]);
    });

    it('refuses a defect that was never mapped to that sub-area', async () => {
      const f = finding('D035', 1);
      const unmapped = mapping.defects.find(
        (d) => !mapping.map.some((e) => e.subAreaId === f.subAreaId && e.defectId === d.id),
      );
      const b = body({ findings: [{ ...f, defectId: unmapped!.id }] });
      expect(paths(await refusal(validator.validate(parts(b, [unmapped!.id]), BUDI, NOW)))).toEqual(
        [['findings[0]', 'INVALID']],
      );
    });

    it('accepts a finding whose map row was deactivated after the tap', async () => {
      const f = finding('D035', 5);
      await testDb.client.query(
        'UPDATE area_map SET active = false WHERE sub_area_id = $1 AND defect_id = $2',
        [f.subAreaId, f.defectId],
      );
      try {
        await expect(validator.validate(parts(body(), TOP), BUDI, NOW)).resolves.toBeDefined();
      } finally {
        await testDb.client.query(
          'UPDATE area_map SET active = true WHERE sub_area_id = $1 AND defect_id = $2',
          [f.subAreaId, f.defectId],
        );
      }
    });
  });

  it('refuses totals in the request as an unknown field (doc 04 §4.1)', async () => {
    const withTotals = { ...body(), totals: { qtyInspection: 30 } };
    const problem = await refusal(validator.validate(parts(withTotals, TOP), BUDI, NOW));
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(paths(problem)).toEqual([['totals', 'UNKNOWN_FIELD']]);
  });

  it('refuses a request that breaks the schema, naming the field', async () => {
    const b = body({ findings: [{ ...finding('D035', 1), qty: 0 }] });
    expect(paths(await refusal(validator.validate(parts(b), BUDI, NOW)))).toEqual([
      ['findings[0].qty', 'INVALID'],
    ]);
  });

  it('answers PHOTO_MISSING when only Top 5 photos are missing', async () => {
    const problem = await refusal(validator.validate(parts(body(), ['D049']), BUDI, NOW));
    expect(problem.code).toBe('PHOTO_MISSING');
    expect(problem.detail).toBe(
      `Foto wajib untuk: D035 ${mapping.defect('D035')?.name}, D082 ${mapping.defect('D082')?.name}`,
    );
  });

  it('answers PHOTO_NOT_ALLOWED when PSI lv.1 sends a photo', async () => {
    const lv1 = body({ user: { username: 'TEST ANDI', level: 'PSI lv.1' } });
    const problem = await refusal(validator.validate(parts(lv1, ['D035']), ANDI, NOW));
    expect(problem).toMatchObject({
      code: 'PHOTO_NOT_ALLOWED',
      detail: 'PSI lv.1 tidak mengirim foto.',
    });
  });

  it('returns every failure together in one VALIDATION_FAILED', async () => {
    const b = body({
      po: '0000000000',
      sealedAt: '2026-10-16T15:00:00.000+07:00',
      counts: { rework: 10, bGrade: 0, noDefect: 18 },
      findings: [finding('D035', 5), finding('D035', 1), finding('D082', 3, 'B-GRADE', 3)],
    });
    const problem = await refusal(
      validator.validate(parts(b, ['D035']), { ...BUDI, sub: 'TEST DEWI' }, NOW),
    );
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(paths(problem)).toEqual([
      ['user', 'USER_NOT_FOUND'],
      ['po', 'PO_NOT_FOUND'],
      ['findings[2].inspectionType', 'INVALID'],
      ['findings[1]', 'DUPLICATE'],
      ['photos', 'PHOTO_MISSING'],
      ['sealedAt', 'INVALID'],
    ]);
  });
});
