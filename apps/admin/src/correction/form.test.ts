import { describe, expect, it } from 'vitest';
import { defaultMapping } from '@m100/shared';
import type { AdminSubmissionDetail } from '../api/types';
import {
  changeLines,
  changeValue,
  evaluate,
  fieldOf,
  type FormContext,
  formFromDetail,
  newFinding,
  photoRows,
  problemsByField,
  requestFromForm,
  sealedAtOf,
  wibParts,
} from './form';

const mapping = defaultMapping();
const entries = [...new Map(mapping.map.map((e) => [e.defectId, e])).values()].slice(0, 7);
const [A, B, C] = entries as [(typeof entries)[0], (typeof entries)[0], (typeof entries)[0]];

function finding(e: (typeof entries)[0], qty: number, second: number) {
  const defect = mapping.defect(e.defectId)!;
  return {
    inspectionType: 'REWORK' as const,
    areaId: e.areaId,
    areaName: 'AREA',
    subAreaId: e.subAreaId,
    subAreaName: 'SUB',
    familyId: e.familyId,
    familyName: 'FAM',
    defectId: e.defectId,
    defectName: defect.name,
    classification: defect.classification,
    qty,
    firstRecordedAt: `2026-11-18T13:00:0${second}.000+07:00`,
  };
}

/** PSI lv.1, Qty Inspection 30, two findings (Qty Defect 5). */
const LV1: AdminSubmissionDetail = {
  countingRule: 'ADR-019',
  id: '0f6b6c1e-6a52-4c9f-9a3e-5d7a2b0c41f2',
  displayNo: 'M100-000123',
  sealedAt: '2026-11-18T14:32:05.123+07:00',
  inspectionDate: '2026-11-18',
  username: 'AZIZAH',
  level: 'PSI lv.1',
  factory: 'F 3',
  cell: 'F3-10',
  po: '0903359388',
  partialText: null,
  qtyInspection: 30,
  qtyDefect: 5,
  qtyAGrade: 25,
  qtyBGrade: 0,
  rft: 0.83333,
  defectRate: 0.16667,
  photoCount: 0,
  revisionNo: 0,
  receivedAt: '2026-11-18T14:32:07.000+07:00',
  appVersion: '1.0.0',
  article: 'ART-1',
  model: 'MODEL 1',
  destination: 'JAPAN',
  orderQty: 100,
  podd: null,
  crd: null,
  partial: null,
  counts: { rework: 4, bGrade: 0, noDefect: null, qtyInspection: 30, reworkApproved: 2 },
  photoRule: null,
  findings: [finding(A, 3, 1), finding(B, 2, 2)],
  top5: [],
  photos: [],
  audit: [],
  latestRevisionNo: 0,
  correctedAt: null,
  correctedBy: null,
  correctionReason: null,
};

/** PSI lv.2 with photo rule ALL and a photo for each of its two defects. */
const LV2: AdminSubmissionDetail = {
  ...LV1,
  countingRule: 'ADR-008',
  level: 'PSI lv.2',
  username: 'BUDI',
  counts: { rework: 4, bGrade: 0, noDefect: 26, qtyInspection: 30, reworkApproved: 2 },
  qtyAGrade: 26,
  photoRule: 'ALL',
  photos: [
    { id: 1, defectId: A.defectId, url: '/v1/admin/photos/1' },
    { id: 2, defectId: B.defectId, url: '/v1/admin/photos/2' },
  ],
  latestRevisionNo: 2,
};

function context(d: AdminSubmissionDetail): FormContext {
  return {
    levelsOf: (name) => (name === d.username ? [d.level] : name === 'SITI' ? ['PSI lv.1'] : []),
    defects: mapping,
    poMaster: null,
    familyOf: (subAreaId, defectId) =>
      mapping.map.find((e) => e.subAreaId === subAreaId && e.defectId === defectId)?.familyId ?? '',
    now: new Date('2026-11-19T10:00:00+07:00'),
  };
}

describe('the correction form (doc 05 §20.3a)', () => {
  it('starts from the detail and is unchanged: no changes, no problems, the same totals', () => {
    const form = formFromDetail(LV1);
    expect(form).toMatchObject({
      date: '2026-11-18',
      time: '14:32',
      qtyInspection: '30',
      noDefect: '',
    });
    const result = evaluate(form, LV1, context(LV1));
    expect(result.problems).toEqual([]);
    expect(result.totals).toMatchObject({ qtyInspection: 30, qtyDefect: 5, qtyAGrade: 25 });
    expect(changeLines(result.changes!, String)).toEqual([]);
  });

  it('keeps the original time to the millisecond until the date or time is edited', () => {
    const form = formFromDetail(LV1);
    expect(sealedAtOf(form, LV1.sealedAt)).toBe(LV1.sealedAt);
    expect(sealedAtOf({ ...form, time: '15:00' }, LV1.sealedAt)).toBe(
      '2026-11-18T15:00:00.000+07:00',
    );
    expect(wibParts('2026-11-18T17:30:00.000Z')).toEqual({ date: '2026-11-19', time: '00:30' });
  });

  it('sends qtyInspection for PSI lv.1 and noDefect for PSI lv.2, with the base revision', () => {
    const lv1 = requestFromForm(formFromDetail(LV1), LV1, 'id-1', 'Salah input oleh PSI');
    expect(lv1.counts).toEqual({ rework: 4, bGrade: 0, reworkApproved: 2, qtyInspection: 30 });
    expect(lv1.baseRevisionNo).toBe(0);
    const lv2 = requestFromForm(formFromDetail(LV2), LV2, 'id-2', 'Salah input oleh PSI');
    expect(lv2.counts).toEqual({ rework: 4, bGrade: 0, reworkApproved: 2, noDefect: 26 });
    expect(lv2.baseRevisionNo).toBe(2);
    expect(lv2.photos).toEqual([
      { defectId: A.defectId, keep: true },
      { defectId: B.defectId, keep: true },
    ]);
  });

  it('shows the same problems as the API: below Qty Defect, a level change, a typing error', () => {
    const form = formFromDetail(LV1);
    const below = evaluate({ ...form, qtyInspection: '4' }, LV1, context(LV1));
    expect(problemsByField(below.problems).get('counts.qtyInspection')).toBe(
      'Qty Inspection minimal 5: jumlah defect yang tercatat.',
    );
    const level = evaluate({ ...formFromDetail(LV2), username: 'SITI' }, LV2, context(LV2));
    expect(level.problems.map((p) => p.code)).toContain('LEVEL_CHANGE');
    const typed = evaluate({ ...form, rework: 'x' }, LV1, context(LV1));
    expect(typed.totals).toBeNull();
    expect(problemsByField(typed.problems).get('counts.rework')).toBe(
      'INSPECTION REWORK QTY harus bilangan bulat.',
    );
  });

  it('lists the changes for the dialog with the new totals', () => {
    const form = formFromDetail(LV1);
    const result = evaluate({ ...form, qtyInspection: '25', cell: 'F3-11' }, LV1, context(LV1));
    expect(result.totals).toMatchObject({ qtyInspection: 25, qtyAGrade: 20 });
    expect(changeLines(result.changes!, (f, v) => changeValue(f, v, 100, String))).toEqual([
      'Cell: F3-10 → F3-11',
      'QTY INSPECTION: 30 → 25',
    ]);
  });

  it('ALL: a new defect needs a photo; a new file is sent as a part, the rest are kept', () => {
    const form = formFromDetail(LV2);
    form.findings.push({
      ...newFinding(),
      areaId: C.areaId,
      subAreaId: C.subAreaId,
      defectId: C.defectId,
    });
    form.noDefect = '25';
    expect(photoRows(form, LV2, mapping).map((r) => [r.defectId, r.required])).toEqual([
      [A.defectId, true],
      [B.defectId, true],
      [C.defectId, true],
    ]);
    const missing = evaluate(form, LV2, context(LV2));
    expect(missing.problems.map((p) => p.code)).toEqual(['PHOTO_MISSING']);

    form.photos[C.defectId] = { kind: 'new', sha256: 'c'.repeat(64), name: 'c.jpg' };
    form.photos[A.defectId] = { kind: 'new', sha256: 'a'.repeat(64), name: 'a.jpg' };
    const ok = evaluate(form, LV2, context(LV2));
    expect(ok.problems).toEqual([]);
    expect(ok.changes).toMatchObject({ photosAdded: [C.defectId], photosReplaced: [A.defectId] });
    const request = requestFromForm(form, LV2, 'id-3', 'Foto salah defect');
    expect(request.photos).toEqual([
      { defectId: A.defectId, part: `photo_${A.defectId}`, sha256: 'a'.repeat(64) },
      { defectId: B.defectId, keep: true },
      { defectId: C.defectId, part: `photo_${C.defectId}`, sha256: 'c'.repeat(64) },
    ]);
  });

  it('PSI lv.1 has no photo rows; a removed finding drops its photo', () => {
    expect(photoRows(formFromDetail(LV1), LV1, mapping)).toEqual([]);
    const form = formFromDetail(LV2);
    form.findings = form.findings.slice(0, 1);
    const request = requestFromForm(form, LV2, 'id-4', 'Defect B salah input');
    expect(request.photos).toEqual([{ defectId: A.defectId, keep: true }]);
  });

  it('maps a server path to its field', () => {
    expect(fieldOf('findings[2].qty')).toBe('findings.2');
    expect(fieldOf('photos[1].keep')).toBe('photos');
    expect(fieldOf('counts.qtyInspection')).toBe('counts.qtyInspection');
  });
});
