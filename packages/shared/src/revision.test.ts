import { describe, expect, it } from 'vitest';
import type {
  DefectId,
  Finding,
  InspectionType,
  Po,
  RevisionOriginal,
  RevisionRequest,
  SubmissionVersion,
} from './domain';
import { defaultMapping } from './mapping';
import {
  checkRevision,
  hasChanges,
  type RevisionContext,
  revisionChanges,
  revisionVersion,
  versionTotals,
} from './revision';

const mapping = defaultMapping();
/** Seven different defects with a map entry each, in mapping order. */
const entries = [...new Map(mapping.map.map((e) => [e.defectId, e])).values()].slice(0, 7);
const [A, B, C] = entries as [(typeof entries)[0], (typeof entries)[0], (typeof entries)[0]];

const NOW = new Date('2026-11-19T10:00:00+07:00');
const SEALED = '2026-11-18T14:32:05.123+07:00';
const SHA = (c: string) => c.repeat(64);

function finding(
  e: (typeof entries)[0],
  qty: number,
  type: InspectionType = 'REWORK',
  at = '2026-11-18T13:00:01.000+07:00',
): Finding {
  return { ...e, inspectionType: type, qty, firstRecordedAt: at };
}

/** The ADR-019 example of doc 02 §9: Qty Inspection 30, 8 REWORK findings, 3 B-GRADE findings. */
const LV1_BASE: SubmissionVersion = {
  sealedAt: SEALED,
  username: 'ANI',
  factory: 'F 3',
  cell: 'F3-10',
  po: '0903359388',
  article: 'ART-1',
  model: 'MODEL 1',
  destination: 'JAPAN',
  orderQty: 100,
  podd: '2026-12-01',
  crd: '2026-12-10',
  partial: null,
  counts: { rework: 10, bGrade: 2, reworkApproved: 4, qtyInspection: 30 },
  findings: [
    finding(A, 8, 'REWORK', '2026-11-18T13:00:01.000+07:00'),
    finding(B, 3, 'B-GRADE', '2026-11-18T13:05:00.000+07:00'),
  ],
  photos: [],
};
const LV1: RevisionOriginal = { level: 'PSI lv.1', countingRule: 'ADR-019', photoRule: null };

const LV2_BASE: SubmissionVersion = {
  ...LV1_BASE,
  username: 'BUDI',
  counts: { rework: 3, bGrade: 1, reworkApproved: 1, noDefect: 20 },
  findings: [finding(A, 2), finding(B, 1, 'B-GRADE', '2026-11-18T13:05:00.000+07:00')],
  photos: [
    { defectId: A.defectId, sha256: SHA('a') },
    { defectId: B.defectId, sha256: SHA('b') },
  ],
};
const LV2: RevisionOriginal = { level: 'PSI lv.2', countingRule: 'ADR-008', photoRule: 'ALL' };

/** A correction that repeats `base` exactly, as the form sends it before any edit. */
function unchanged(base: SubmissionVersion): RevisionRequest {
  const { counts } = base;
  return {
    revisionId: '7a1f0a52-4c0e-4f39-9d8d-7d5e3f0b9b11',
    baseRevisionNo: 0,
    reason: 'Salah input QTY INSPECTION oleh PSI',
    sealedAt: base.sealedAt,
    username: base.username,
    factory: base.factory,
    cell: base.cell,
    po: base.po,
    partial: base.partial,
    counts: {
      rework: counts.rework,
      bGrade: counts.bGrade,
      reworkApproved: counts.reworkApproved ?? 0,
      ...(counts.noDefect !== undefined
        ? { noDefect: counts.noDefect }
        : { qtyInspection: counts.qtyInspection }),
    },
    findings: base.findings.map((f) => ({
      inspectionType: f.inspectionType,
      areaId: f.areaId,
      subAreaId: f.subAreaId,
      familyId: f.familyId,
      defectId: f.defectId,
      qty: f.qty,
    })),
    photos: base.photos.map((p) => ({ defectId: p.defectId, keep: true as const })),
  };
}

function context(level: RevisionOriginal['level'], orderQty = 100): RevisionContext {
  return { userLevel: level, orderQty, defects: mapping, now: NOW };
}

const codes = (failures: { path: string; code: string }[]) => failures.map((f) => [f.path, f.code]);

describe('checkRevision (ADR-023)', () => {
  it('accepts the doc 02 §9 example corrected to Qty Inspection 25, giving A-Grade 14', () => {
    const request = unchanged(LV1_BASE);
    request.counts.qtyInspection = 25;
    expect(checkRevision(request, LV1, LV1_BASE, context('PSI lv.1'))).toEqual([]);
    const after = revisionVersion(request, LV1_BASE, null, NOW.toISOString());
    expect(versionTotals(LV1_BASE)).toMatchObject({
      qtyInspection: 30,
      qtyDefect: 11,
      qtyAGrade: 19,
    });
    expect(versionTotals(after)).toMatchObject({
      qtyInspection: 25,
      qtyDefect: 11,
      qtyBGrade: 3,
      qtyAGrade: 14,
    });
    expect(versionTotals(after).passRate).toBeCloseTo(14 / 25);
  });

  it('refuses Qty Inspection below Qty Defect, above the partial and above Qty Order, as a submission', () => {
    const below = unchanged(LV1_BASE);
    below.counts.qtyInspection = 10;
    expect(checkRevision(below, LV1, LV1_BASE, context('PSI lv.1')).map((f) => f.message)).toEqual([
      'Qty Inspection minimal 11: jumlah defect yang tercatat.',
    ]);

    const abovePartial = unchanged(LV1_BASE);
    abovePartial.partial = { number: 1, qty: 20 };
    expect(
      checkRevision(abovePartial, LV1, LV1_BASE, context('PSI lv.1')).map((f) => f.message),
    ).toEqual(['Qty Inspection maksimal 20 pasang.']);

    const aboveOrder = unchanged(LV1_BASE);
    aboveOrder.counts.qtyInspection = 101;
    expect(
      checkRevision(aboveOrder, LV1, LV1_BASE, context('PSI lv.1')).map((f) => f.message),
    ).toEqual(['Qty Inspection maksimal 100 pasang.']);
  });

  it('refuses PSI lv.2 tapped pairs above the maximum and Rework and Approved above rework', () => {
    const request = unchanged(LV2_BASE);
    request.counts.noDefect = 97; // 3 + 1 + 97 = 101 pairs
    request.counts.reworkApproved = 4;
    expect(codes(checkRevision(request, LV2, LV2_BASE, context('PSI lv.2')))).toEqual([
      ['counts', 'INVALID'],
      ['counts.reworkApproved', 'INVALID'],
    ]);
  });

  it('refuses another level, counts of the other rule, a missing approval and a short or long reason', () => {
    const level = unchanged(LV1_BASE);
    level.username = 'BUDI';
    level.counts.qtyInspection = 29;
    expect(codes(checkRevision(level, LV1, LV1_BASE, context('PSI lv.2')))).toEqual([
      ['username', 'LEVEL_CHANGE'],
    ]);

    const rule = unchanged(LV1_BASE);
    rule.counts = { rework: 10, bGrade: 2, reworkApproved: 4, noDefect: 18 };
    expect(codes(checkRevision(rule, LV1, LV1_BASE, context('PSI lv.1')))[0]).toEqual([
      'counts',
      'INVALID',
    ]);

    // As a client that leaves it out would send it (the API's schema refuses it first; this is the second line).
    const { rework, bGrade } = unchanged(LV1_BASE).counts;
    const approval = {
      ...unchanged(LV1_BASE),
      counts: { rework, bGrade, qtyInspection: 29 },
    } as unknown as RevisionRequest;
    expect(codes(checkRevision(approval, LV1, LV1_BASE, context('PSI lv.1')))).toEqual([
      ['counts.reworkApproved', 'REQUIRED'],
    ]);

    for (const reason of ['123456789', 'x'.repeat(501), '   tidak  ']) {
      const request = unchanged(LV1_BASE);
      request.counts.qtyInspection = 29;
      request.reason = reason;
      expect(codes(checkRevision(request, LV1, LV1_BASE, context('PSI lv.1')))).toEqual([
        ['reason', 'INVALID'],
      ]);
    }
    const edge = unchanged(LV1_BASE);
    edge.counts.qtyInspection = 29;
    edge.reason = `  ${'x'.repeat(500)}  `;
    expect(checkRevision(edge, LV1, LV1_BASE, context('PSI lv.1'))).toEqual([]);
  });

  it('refuses a duplicate finding, a finding of an inspection not started and a future time', () => {
    const request = unchanged(LV1_BASE);
    request.findings.push({ ...request.findings[0]! });
    request.counts.bGrade = 0;
    request.sealedAt = '2026-11-19T10:06:00+07:00';
    expect(codes(checkRevision(request, LV1, LV1_BASE, context('PSI lv.1')))).toEqual([
      ['findings[1].inspectionType', 'INVALID'],
      ['findings[2]', 'DUPLICATE'],
      ['sealedAt', 'INVALID'],
    ]);
  });

  it('is NO_CHANGE for an identical correction, also with the time written differently', () => {
    const same = unchanged(LV1_BASE);
    expect(codes(checkRevision(same, LV1, LV1_BASE, context('PSI lv.1')))).toEqual([
      ['', 'NO_CHANGE'],
    ]);
    same.sealedAt = new Date(SEALED).toISOString();
    expect(codes(checkRevision(same, LV1, LV1_BASE, context('PSI lv.1')))).toEqual([
      ['', 'NO_CHANGE'],
    ]);
  });
});

describe('photos of a correction', () => {
  it('ALL: a new defect without a photo is PHOTO_MISSING; with a new photo it passes', () => {
    const request = unchanged(LV2_BASE);
    request.findings.push({ ...C, inspectionType: 'REWORK', qty: 1 });
    expect(codes(checkRevision(request, LV2, LV2_BASE, context('PSI lv.2')))).toEqual([
      ['photos', 'PHOTO_MISSING'],
    ]);
    request.photos.push({ defectId: C.defectId, part: `photo_${C.defectId}`, sha256: SHA('c') });
    expect(checkRevision(request, LV2, LV2_BASE, context('PSI lv.2'))).toEqual([]);
  });

  it('TOP5 (legacy rule) needs only the Top 5 of seven defects', () => {
    const base: SubmissionVersion = {
      ...LV2_BASE,
      counts: { rework: 7, bGrade: 0, reworkApproved: 0, noDefect: 10 },
      findings: entries.map((e, i) =>
        finding(e, 7 - i, 'REWORK', `2026-11-18T13:00:0${i}.000+07:00`),
      ),
      photos: entries.slice(0, 5).map((e) => ({ defectId: e.defectId, sha256: SHA('d') })),
    };
    const legacy: RevisionOriginal = { ...LV2, photoRule: 'TOP5' };
    const request = unchanged(base);
    request.counts.noDefect = 11;
    expect(checkRevision(request, legacy, base, context('PSI lv.2'))).toEqual([]);
    expect(
      checkRevision(request, LV2, base, context('PSI lv.2')).filter(
        (f) => f.code === 'PHOTO_MISSING',
      ),
    ).toHaveLength(2);
  });

  it('PSI lv.1 sends no photo; a keep needs a photo in the base; one photo per defect with a finding', () => {
    const lv1 = unchanged(LV1_BASE);
    lv1.photos = [{ defectId: A.defectId, part: `photo_${A.defectId}`, sha256: SHA('a') }];
    expect(codes(checkRevision(lv1, LV1, LV1_BASE, context('PSI lv.1')))).toEqual([
      ['photos', 'PHOTO_NOT_ALLOWED'],
    ]);

    const keep = unchanged(LV2_BASE);
    keep.findings.push({ ...C, inspectionType: 'REWORK', qty: 1 });
    keep.photos.push({ defectId: C.defectId, keep: true });
    expect(codes(checkRevision(keep, LV2, LV2_BASE, context('PSI lv.2')))).toEqual([
      ['photos[2].keep', 'INVALID'],
    ]);

    const extra = unchanged(LV2_BASE);
    extra.photos.push({ defectId: A.defectId, keep: true });
    extra.photos.push({ defectId: C.defectId, part: `photo_${C.defectId}`, sha256: SHA('c') });
    expect(codes(checkRevision(extra, LV2, LV2_BASE, context('PSI lv.2')))).toEqual([
      ['photos[2].defectId', 'DUPLICATE'],
      ['photos[3].defectId', 'INVALID'],
    ]);
  });
});

describe('revisionVersion', () => {
  const master: Po = {
    po: '0903359999',
    article: 'ART-9',
    model: 'MODEL 9',
    destination: 'USA',
    orderQty: 50,
    podd: null,
    crd: '2027-01-05',
  };

  it('takes the snapshot of a changed PO from the PO master', () => {
    const request = unchanged(LV1_BASE);
    request.po = master.po;
    const after = revisionVersion(request, LV1_BASE, master, NOW.toISOString());
    expect(after).toMatchObject({
      po: '0903359999',
      article: 'ART-9',
      model: 'MODEL 9',
      destination: 'USA',
      orderQty: 50,
      podd: null,
      crd: '2027-01-05',
    });
    expect(() => revisionVersion(request, LV1_BASE, { ...master, po: 'X' }, '')).toThrow();
  });

  it('keeps the base snapshot when the PO is unchanged, whatever the master says now', () => {
    const request = unchanged(LV1_BASE);
    request.counts.qtyInspection = 29;
    const after = revisionVersion(
      request,
      LV1_BASE,
      { ...master, po: LV1_BASE.po, article: 'EDITED' },
      NOW.toISOString(),
    );
    expect(after.article).toBe('ART-1');
    expect(after.orderQty).toBe(100);
  });

  it('keeps firstRecordedAt of the same finding or defect; a new defect gets the correction time', () => {
    const request = unchanged(LV1_BASE);
    request.findings[0] = { ...request.findings[0]!, subAreaId: 'MOVED' };
    request.findings.push({ ...C, inspectionType: 'REWORK', qty: 1 });
    const after = revisionVersion(request, LV1_BASE, null, NOW.toISOString());
    expect(after.findings.map((f) => f.firstRecordedAt)).toEqual([
      '2026-11-18T13:00:01.000+07:00',
      '2026-11-18T13:05:00.000+07:00',
      NOW.toISOString(),
    ]);
  });

  it('keeps the SHA-256 of a kept photo and takes the new one of a replaced photo', () => {
    const request = unchanged(LV2_BASE);
    request.photos[1] = { defectId: B.defectId, part: `photo_${B.defectId}`, sha256: SHA('e') };
    const after = revisionVersion(request, LV2_BASE, null, NOW.toISOString());
    expect(after.photos).toEqual([
      { defectId: A.defectId, sha256: SHA('a') },
      { defectId: B.defectId, sha256: SHA('e') },
    ]);
  });
});

describe('revisionChanges', () => {
  it('is empty for equal versions', () => {
    const changes = revisionChanges(LV2_BASE, structuredClone(LV2_BASE));
    expect(hasChanges(changes)).toBe(false);
    expect(changes.fields).toEqual([]);
  });

  it('lists header fields, partial, counts, findings and photos that changed', () => {
    const after: SubmissionVersion = {
      ...structuredClone(LV2_BASE),
      sealedAt: '2026-11-18T15:00:00.000+07:00',
      cell: 'F3-11',
      partial: { number: 1, qty: 60 },
      counts: { rework: 3, bGrade: 1, reworkApproved: 2, noDefect: 21 },
      findings: [finding(A, 3), finding(C, 1)],
      photos: [
        { defectId: A.defectId, sha256: SHA('f') },
        { defectId: C.defectId, sha256: SHA('c') },
      ],
    };
    const changes = revisionChanges(LV2_BASE, after);
    expect(changes.fields).toEqual([
      { field: 'sealedAt', old: SEALED, new: '2026-11-18T15:00:00.000+07:00' },
      { field: 'cell', old: 'F3-10', new: 'F3-11' },
      { field: 'partial', old: null, new: { number: 1, qty: 60 } },
      { field: 'counts.reworkApproved', old: 1, new: 2 },
      { field: 'counts.noDefect', old: 20, new: 21 },
    ]);
    const id = (d: DefectId) => d;
    expect(changes.findingsAdded.map((f) => f.defectId)).toEqual([id(C.defectId)]);
    expect(changes.findingsRemoved.map((f) => f.defectId)).toEqual([id(B.defectId)]);
    expect(changes.findingsChanged).toEqual([
      expect.objectContaining({ defectId: A.defectId, qty: 3, oldQty: 2 }),
    ]);
    expect(changes.photosAdded).toEqual([C.defectId]);
    expect(changes.photosReplaced).toEqual([A.defectId]);
    expect(changes.photosRemoved).toEqual([B.defectId]);
    expect(hasChanges(changes)).toBe(true);
  });
});
