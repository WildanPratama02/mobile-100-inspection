import { describe, expect, it } from 'vitest';
import type { DefectId, Finding } from './domain';
import { defaultMapping } from './mapping';
import {
  checkClock,
  checkCounts,
  checkDuplicateFindings,
  checkPartial,
  findingKey,
  photoCoverage,
} from './rules';

const mapping = defaultMapping();
const entries = [...new Map(mapping.map.map((e) => [e.defectId, e])).values()].slice(0, 7);
const f = (i: number, qty: number, type: Finding['inspectionType'] = 'REWORK'): Finding => ({
  ...entries[i]!,
  inspectionType: type,
  qty,
  firstRecordedAt: `2026-11-18T13:00:0${i}.000+07:00`,
});

describe('rules shared by submissions and corrections (doc 04 §4.2)', () => {
  it('checkCounts keeps the API messages for ADR-019, tapped counts and BR-11', () => {
    const findings = [f(0, 8), f(1, 3, 'B-GRADE')];
    expect(
      checkCounts(
        { counts: { rework: 10, bGrade: 2, qtyInspection: 30 }, findings, partial: null },
        100,
      ),
    ).toEqual([]);
    expect(
      checkCounts(
        {
          counts: { rework: 10, bGrade: 2, qtyInspection: 5 },
          findings,
          partial: { number: 1, qty: 9 },
        },
        100,
      ).map((x) => x.message),
    ).toEqual([
      'Qty Inspection minimal 11: jumlah defect yang tercatat.',
      'Qty Inspection maksimal 9 pasang.',
    ]);
    expect(
      checkCounts(
        { counts: { rework: 0, bGrade: 0, noDefect: 0 }, findings: [], partial: null },
        5,
      ),
    ).toEqual([
      { path: 'counts', code: 'INVALID', message: 'Qty Inspection 0: belum ada inspeksi.' },
    ]);
    expect(
      checkCounts(
        {
          counts: { rework: 1, bGrade: 0, noDefect: 1, reworkApproved: 2 },
          findings: [f(0, 1)],
          partial: null,
        },
        5,
      ),
    ).toEqual([
      {
        path: 'counts.reworkApproved',
        code: 'INVALID',
        message: 'REWORK AND APPROVED maksimal 1 pasang (INSPECTION REWORK QTY).',
      },
    ]);
    // A legacy NULL approval is not checked (doc 02 §4.1).
    expect(
      checkCounts(
        {
          counts: { rework: 1, bGrade: 0, noDefect: 1, reworkApproved: null },
          findings: [f(0, 1)],
          partial: null,
        },
        5,
      ),
    ).toEqual([]);
  });

  it('checkDuplicateFindings, checkPartial and checkClock', () => {
    expect(checkDuplicateFindings({ findings: [f(0, 1), f(0, 2), f(0, 1, 'B-GRADE')] })).toEqual([
      { path: 'findings[1]', code: 'DUPLICATE', message: 'Temuan ini dikirim dua kali.' },
    ]);
    expect(findingKey(f(0, 1))).not.toBe(findingKey(f(0, 1, 'B-GRADE')));
    expect(checkPartial({ partial: { number: 1, qty: 101 } }, 100)).toHaveLength(1);
    expect(checkPartial({ partial: { number: 1, qty: 100 } }, 100)).toEqual([]);
    expect(checkPartial({ partial: { number: 1, qty: 101 } }, null)).toEqual([]);
    const now = new Date('2026-11-19T10:00:00+07:00');
    expect(checkClock('2026-11-19T10:05:00+07:00', now)).toEqual([]);
    expect(checkClock('2026-11-19T10:05:01+07:00', now)).toHaveLength(1);
  });

  it('photoCoverage: every defect under ALL, the Top 5 under TOP5, labelled with the defect name', () => {
    const findings = entries.map((_, i) => f(i, 7 - i));
    const none = new Set<DefectId>();
    expect(photoCoverage(findings, none, 'ALL', mapping)).toHaveLength(7);
    const top = photoCoverage(findings, none, 'TOP5', mapping);
    expect(top.map((x) => x.message)).toEqual(
      entries.slice(0, 5).map((e) => `Foto wajib untuk ${e.defectId}.`),
    );
    expect(top[0]!.label).toBe(
      `${entries[0]!.defectId} ${mapping.defect(entries[0]!.defectId)!.name}`,
    );
    expect(
      photoCoverage(findings, new Set(entries.map((e) => e.defectId)), 'ALL', mapping),
    ).toEqual([]);
  });
});
