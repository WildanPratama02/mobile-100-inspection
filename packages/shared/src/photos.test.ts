import { describe, expect, it } from 'vitest';
import type { RankedDefect } from './counting';
import type { DefectId } from './domain';
import { missingPhotos, photoKey, takesPhotos } from './photos';

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

describe('photoKey (doc 02 §7)', () => {
  const uuid = '0f6b6c1e-6a52-4c9f-9a3e-5d7a2b0c41f2';

  it('is submissions/<yyyy>/<MM>/<uuid>/<defectId>.jpg', () => {
    expect(photoKey(uuid, 'D035', '2026-10-16T14:32:05+07:00')).toBe(
      `submissions/2026/10/${uuid}/D035.jpg`,
    );
  });

  it('takes the month in WIB, not UTC', () => {
    expect(photoKey(uuid, 'D035', '2026-10-31T17:30:00Z')).toBe(
      `submissions/2026/11/${uuid}/D035.jpg`,
    );
    expect(photoKey(uuid, 'D082', new Date('2026-12-31T17:00:00Z'))).toBe(
      `submissions/2027/01/${uuid}/D082.jpg`,
    );
  });

  it('gives the same key for the same moment in any offset, so a retry overwrites its photo', () => {
    expect(photoKey(uuid, 'D049', '2026-11-01T00:30:00+07:00')).toBe(
      photoKey(uuid, 'D049', '2026-10-31T17:30:00.000Z'),
    );
  });
});
