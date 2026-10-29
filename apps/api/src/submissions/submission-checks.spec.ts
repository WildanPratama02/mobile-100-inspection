import {
  defaultMapping,
  type DefectId,
  type Finding,
  type InspectionType,
  type SubmissionRequest,
} from '@m100/shared';
import { checksFailed, type Failure } from '../errors/validation';
import { sha256Hex } from './multipart';
import {
  checkClock,
  checkCounts,
  checkDuplicateFindings,
  checkPartial,
  checkPhotos,
  checkSubmission,
  type KnownDefect,
} from './submission-checks';

const mapping = defaultMapping();
const defects = new Map<string, KnownDefect>(
  mapping.defects.map((d) => [d.id, { name: d.name, classification: d.classification }]),
);

function finding(
  defectId: DefectId,
  qty: number,
  inspectionType: InspectionType = 'REWORK',
  second = 1,
): Finding {
  const entry = mapping.map.find((e) => e.defectId === defectId);
  if (!entry) throw new Error(`No map entry for ${defectId}`);
  const { areaId, subAreaId, familyId } = entry;
  return {
    inspectionType,
    areaId,
    subAreaId,
    familyId,
    defectId,
    qty,
    firstRecordedAt: `2026-10-16T13:00:${String(second).padStart(2, '0')}.250+07:00`,
  };
}

/** A JPEG-looking photo, different for every seed. */
const jpeg = (seed: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(seed)]);

function request(overrides: Partial<SubmissionRequest> = {}): SubmissionRequest {
  return {
    submissionUuid: '0f6b6c1e-6a52-4c9f-9a3e-5d7a2b0c41f2',
    sealedAt: '2026-10-16T14:32:05.000+07:00',
    appVersion: '1.0.0',
    user: { username: 'TEST BUDI', level: 'PSI lv.2' },
    factory: 'F 1',
    cell: 'F1-1',
    po: '0902028839',
    partial: null,
    counts: { rework: 3, bGrade: 1, noDefect: 2 },
    findings: [],
    photos: [],
    ...overrides,
  };
}

/** The request with one photo entry and part per defect. */
function withPhotos(base: SubmissionRequest, ids: DefectId[]) {
  const parts = new Map(ids.map((id) => [`photo_${id}`, jpeg(id)]));
  const photos = ids.map((id) => ({
    defectId: id,
    part: `photo_${id}`,
    sha256: sha256Hex(parts.get(`photo_${id}`) as Buffer),
  }));
  return { request: { ...base, photos }, parts };
}

const codes = (failures: Failure[]) => failures.map((f) => [f.path, f.code]);
const NOW = new Date('2026-10-16T07:32:05.000Z');

describe('rules 3 and 4: counts against findings (doc 04 §4.2; the request carries no totals)', () => {
  it('reports both limits when findings exceed the order quantity, even above the minimum', () => {
    const failures = checkCounts(
      request({
        counts: { rework: 1, bGrade: 0, qtyInspection: 30 },
        findings: [finding('D035', 20)],
      }),
      17,
    );
    expect(failures).toEqual([
      {
        path: 'counts.qtyInspection',
        code: 'INVALID',
        message: 'Qty Inspection minimal 20: jumlah defect yang tercatat.',
      },
      {
        path: 'counts.qtyInspection',
        code: 'INVALID',
        message: 'Qty Inspection maksimal 17 pasang.',
      },
    ]);
  });

  it('refuses Qty Inspection 0', () => {
    expect(codes(checkCounts(request({ counts: { rework: 0, bGrade: 0, noDefect: 0 } })))).toEqual([
      ['counts', 'INVALID'],
    ]);
  });

  it('refuses a B-GRADE finding without a B-GRADE inspection', () => {
    const r = request({
      counts: { rework: 1, bGrade: 0, noDefect: 0 },
      findings: [finding('D035', 1), finding('D082', 1, 'B-GRADE')],
    });
    expect(codes(checkCounts(r))).toEqual([['findings[1].inspectionType', 'INVALID']]);
  });

  it('refuses a REWORK finding without a REWORK inspection', () => {
    const r = request({
      counts: { rework: 0, bGrade: 1, noDefect: 0 },
      findings: [finding('D035', 2)],
    });
    expect(codes(checkCounts(r))).toEqual([['findings[0].inspectionType', 'INVALID']]);
  });

  it('accepts findings of started types', () => {
    const r = request({ findings: [finding('D035', 5), finding('D082', 2, 'B-GRADE')] });
    expect(checkCounts(r)).toEqual([]);
  });
});

describe('rule 5: duplicate findings', () => {
  it('refuses the second finding with the same type, area, sub-area and defect', () => {
    const r = request({ findings: [finding('D035', 1), finding('D082', 1), finding('D035', 2)] });
    expect(codes(checkDuplicateFindings(r))).toEqual([['findings[2]', 'DUPLICATE']]);
  });

  it('accepts the same defect under the other inspection type', () => {
    const r = request({ findings: [finding('D035', 1), finding('D035', 1, 'B-GRADE')] });
    expect(checkDuplicateFindings(r)).toEqual([]);
  });
});

describe('rule 6: partial quantity', () => {
  it('refuses a quantity above ORDER QTY and accepts ORDER QTY itself', () => {
    expect(codes(checkPartial(request({ partial: { number: 1, qty: 18 } }), 17))).toEqual([
      ['partial.qty', 'INVALID'],
    ]);
    expect(checkPartial(request({ partial: { number: 1, qty: 17 } }), 17)).toEqual([]);
  });

  it('is left to PO_NOT_FOUND when the PO is unknown', () => {
    expect(checkPartial(request({ partial: { number: 1, qty: 18 } }), null)).toEqual([]);
  });
});

describe('rule 7: photos (FR-10, BR-04)', () => {
  // Six defects: D001 has the lowest quantity and is rank 6.
  const six = [
    finding('D035', 4),
    finding('D082', 3, 'REWORK', 2),
    finding('D010', 3, 'REWORK', 3),
    finding('D020', 2, 'REWORK', 4),
    finding('D030', 2, 'REWORK', 5),
    finding('D001', 1, 'REWORK', 6),
  ];
  const TOP: DefectId[] = ['D035', 'D082', 'D010', 'D020', 'D030'];

  it('accepts one photo per Top 5 defect for PSI lv.2', () => {
    const { request: r, parts } = withPhotos(request({ findings: six }), TOP);
    expect(checkPhotos(r, parts, defects)).toEqual([]);
  });

  it('lists the Top 5 defects without a photo, in rank order, with ID and name', () => {
    const { request: r, parts } = withPhotos(request({ findings: six }), ['D082', 'D020', 'D030']);
    const failures = checkPhotos(r, parts, defects);
    expect(codes(failures)).toEqual([
      ['photos', 'PHOTO_MISSING'],
      ['photos', 'PHOTO_MISSING'],
    ]);
    expect(failures.map((f) => f.label)).toEqual([
      `D035 ${mapping.defect('D035')?.name}`,
      `D010 ${mapping.defect('D010')?.name}`,
    ]);
  });

  it('accepts a photo of a defect outside the Top 5 (AC-10.4)', () => {
    const { request: r, parts } = withPhotos(request({ findings: six }), [...TOP, 'D001']);
    expect(checkPhotos(r, parts, defects)).toEqual([]);
  });

  it('refuses a photo of a defect without a finding', () => {
    const { request: r, parts } = withPhotos(request({ findings: [finding('D035', 1)] }), [
      'D035',
      'D049',
    ]);
    expect(codes(checkPhotos(r, parts, defects))).toEqual([['photos[1].defectId', 'INVALID']]);
  });

  it('refuses two photos for one defect', () => {
    const { request: r, parts } = withPhotos(request({ findings: [finding('D035', 1)] }), ['D035']);
    const twice = { ...r, photos: [r.photos[0]!, r.photos[0]!] };
    expect(codes(checkPhotos(twice, parts, defects))).toEqual([
      ['photos[1].defectId', 'DUPLICATE'],
    ]);
  });

  it('refuses an entry without its part and a part without an entry', () => {
    const { request: r } = withPhotos(request({ findings: [finding('D035', 1)] }), ['D035']);
    expect(codes(checkPhotos(r, new Map(), defects))).toEqual([['photos[0].part', 'REQUIRED']]);
    const parts = new Map([
      ['photo_D035', jpeg('D035')],
      ['photo_D049', jpeg('D049')],
    ]);
    expect(codes(checkPhotos(r, parts, defects))).toEqual([['photo_D049', 'UNKNOWN_PART']]);
  });

  it('refuses an entry whose part is named after another defect', () => {
    const { request: r, parts } = withPhotos(request({ findings: [finding('D035', 1)] }), ['D035']);
    const renamed = { ...r, photos: [{ ...r.photos[0]!, part: 'photo_D049' }] };
    expect(codes(checkPhotos(renamed, parts, defects))).toEqual([
      ['photos[0].part', 'INVALID'],
      ['photo_D035', 'UNKNOWN_PART'],
    ]);
  });

  it('refuses a part that is not a JPEG', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const r = request({
      findings: [finding('D035', 1)],
      photos: [{ defectId: 'D035', part: 'photo_D035', sha256: sha256Hex(png) }],
    });
    expect(codes(checkPhotos(r, new Map([['photo_D035', png]]), defects))).toEqual([
      ['photo_D035', 'NOT_JPEG'],
    ]);
  });

  it('refuses a photo whose SHA-256 does not match its entry', () => {
    const { request: r, parts } = withPhotos(request({ findings: [finding('D035', 1)] }), ['D035']);
    parts.set('photo_D035', jpeg('another photo'));
    expect(codes(checkPhotos(r, parts, defects))).toEqual([
      ['photos[0].sha256', 'SHA256_MISMATCH'],
    ]);
  });

  it('refuses any photo from PSI lv.1, as an entry or as a part (AC-10.6)', () => {
    const lv1 = request({
      user: { username: 'TEST ANDI', level: 'PSI lv.1' },
      findings: [finding('D035', 1)],
    });
    const { request: r, parts } = withPhotos(lv1, ['D035']);
    expect(codes(checkPhotos(r, parts, defects))).toEqual([['photos', 'PHOTO_NOT_ALLOWED']]);
    expect(codes(checkPhotos(lv1, parts, defects))).toEqual([['photos', 'PHOTO_NOT_ALLOWED']]);
    expect(checkPhotos(lv1, new Map(), defects)).toEqual([]);
  });

  it('ranks only defects that exist, leaving unknown ones to the master checks', () => {
    const r = request({
      findings: [finding('D035', 1), { ...finding('D035', 9), defectId: 'D999' }],
    });
    expect(codes(checkPhotos(r, new Map(), defects))).toEqual([['photos', 'PHOTO_MISSING']]);
  });
});

describe('rule 8: tablet clock', () => {
  it('accepts sealedAt up to 5 minutes ahead and refuses more', () => {
    const at = (minutes: number) =>
      request({ sealedAt: new Date(NOW.getTime() + minutes * 60_000).toISOString() });
    expect(checkClock(at(4), NOW)).toEqual([]);
    expect(checkClock(at(5), NOW)).toEqual([]);
    expect(codes(checkClock(at(6), NOW))).toEqual([['sealedAt', 'INVALID']]);
  });
});

describe('checkSubmission and checksFailed (doc 04 §4.2, §6)', () => {
  it('returns every failure of every rule together', () => {
    const r = request({
      sealedAt: '2026-10-16T15:00:00.000+07:00',
      counts: { rework: 0, bGrade: 0, noDefect: 0 },
      partial: { number: 2, qty: 50 },
      findings: [finding('D035', 1), finding('D035', 1)],
    });
    const failures = checkSubmission(r, new Map(), { orderQty: 17, defects, now: NOW });
    expect(codes(failures)).toEqual([
      ['counts', 'INVALID'],
      ['findings[0].inspectionType', 'INVALID'],
      ['findings[1].inspectionType', 'INVALID'],
      ['findings[1]', 'DUPLICATE'],
      ['partial.qty', 'INVALID'],
      ['photos', 'PHOTO_MISSING'],
      ['sealedAt', 'INVALID'],
    ]);
    const problem = checksFailed(failures);
    expect(problem.getStatus()).toBe(422);
    expect(problem.body.code).toBe('VALIDATION_FAILED');
    expect(problem.body.errors).toHaveLength(7);
    expect(problem.body.detail).toBe(
      'Data tidak lengkap: counts, findings[0].inspectionType, findings[1].inspectionType, findings[1], partial.qty, photos, sealedAt',
    );
  });

  it('answers PHOTO_MISSING with the defects when only photos are missing', () => {
    const r = request({ findings: [finding('D035', 2), finding('D082', 1, 'REWORK', 2)] });
    const failures = checkSubmission(r, new Map(), { orderQty: 17, defects, now: NOW });
    const problem = checksFailed(failures);
    expect(problem.body).toMatchObject({
      status: 422,
      code: 'PHOTO_MISSING',
      detail: `Foto wajib untuk: D035 ${mapping.defect('D035')?.name}, D082 ${mapping.defect('D082')?.name}`,
    });
    expect(problem.body.errors?.map((e) => e.code)).toEqual(['PHOTO_MISSING', 'PHOTO_MISSING']);
    expect(problem.body.errors?.[0]).not.toHaveProperty('label');
  });

  it('answers PHOTO_NOT_ALLOWED with its fixed text for PSI lv.1', () => {
    const problem = checksFailed([
      { path: 'photos', code: 'PHOTO_NOT_ALLOWED', message: 'PSI lv.1 tidak mengirim foto.' },
    ]);
    expect(problem.body).toMatchObject({
      code: 'PHOTO_NOT_ALLOWED',
      detail: 'PSI lv.1 tidak mengirim foto.',
    });
  });

  it('answers PO_NOT_FOUND with 422, not 404', () => {
    const problem = checksFailed([{ path: 'po', code: 'PO_NOT_FOUND', message: 'x' }]);
    expect(problem.getStatus()).toBe(422);
    expect(problem.body).toMatchObject({ status: 422, code: 'PO_NOT_FOUND' });
  });

  it('answers VALIDATION_FAILED when specific codes are mixed', () => {
    const problem = checksFailed([
      { path: 'user', code: 'USER_NOT_FOUND', message: 'x' },
      { path: 'photos', code: 'PHOTO_MISSING', message: 'y', label: 'D035' },
    ]);
    expect(problem.body.code).toBe('VALIDATION_FAILED');
    expect(problem.body.errors?.map((e) => e.code)).toEqual(['USER_NOT_FOUND', 'PHOTO_MISSING']);
  });
});
