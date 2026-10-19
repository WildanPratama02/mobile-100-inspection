import { describe, expect, it } from 'vitest';
import type { RankedDefect } from './counting';
import type { DefectId } from './domain';
import { missingPhotos, takesPhotos } from './photos';

function ranked(defectId: DefectId, qty: number): RankedDefect {
  return {
    defectId,
    classification: 'MAJOR',
    qty,
    areaIds: ['A01'],
    firstRecordedAt: '2026-10-19T01:00:00.000Z',
  };
}

describe('takesPhotos (AC-10.6)', () => {
  it('is true for PSI lv.2 only', () => {
    expect(takesPhotos('PSI lv.2')).toBe(true);
    expect(takesPhotos('PSI lv.1')).toBe(false);
  });
});

describe('missingPhotos (BR-04)', () => {
  const top = [ranked('D035', 4), ranked('D049', 3), ranked('D071', 2), ranked('D082', 1)];

  it('lists the Top 5 defects without a photo, in rank order', () => {
    const missing = missingPhotos(top, new Set<DefectId>(['D049']));
    expect(missing.map((r) => r.defectId)).toEqual(['D035', 'D071', 'D082']);
  });

  it('keys by DEFECT_ID, so D049 and D071 are separate even with the same name (ADR-009)', () => {
    const missing = missingPhotos(top, new Set<DefectId>(['D035', 'D071', 'D082']));
    expect(missing.map((r) => r.defectId)).toEqual(['D049']);
  });

  it('ignores photos of defects outside the Top 5 (AC-10.4)', () => {
    expect(missingPhotos(top, new Set<DefectId>(['D001', 'D035', 'D049', 'D071', 'D082']))).toEqual(
      [],
    );
  });

  it('is empty for an empty Top 5', () => {
    expect(missingPhotos([], new Set())).toEqual([]);
  });
});
