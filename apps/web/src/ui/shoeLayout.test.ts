import { describe, expect, it } from 'vitest';
import { SHOE_AREAS, SHOE_AREAS_COMPACT, minMapHeight } from './shoeLayout';

describe('compact shoe map docks (doc 05 U13)', () => {
  it('keeps every pill, its lines, side and anchor; only the dock moves', () => {
    expect(SHOE_AREAS_COMPACT).toHaveLength(12);
    SHOE_AREAS_COMPACT.forEach((area, i) => {
      expect({ ...area, dock: null }).toEqual({ ...SHOE_AREAS[i], dock: null });
      expect(area.dock[0]).toBeGreaterThanOrEqual(0);
      expect(area.dock[1]).toBeGreaterThanOrEqual(0);
    });
  });

  it('fits 44 px pills in the map of a 412 px tall Compact screen, where the design-system docks do not', () => {
    // 412 − outer and pane padding (2 × 8 + 2 × 8) − command row and END (2 × 44) − gaps (2 × 8) = 276.
    const compactMap = 412 - 32 - 88 - 16;
    expect(minMapHeight(SHOE_AREAS)).toBeGreaterThan(compactMap);
    expect(minMapHeight(SHOE_AREAS_COMPACT)).toBeLessThan(230);
  });

  it('measures the closest pills on a side', () => {
    // TONGUE … HEEL are 75 apart in the 720 high box: 44 px pills need 44 × 720 / 75 px.
    const left = SHOE_AREAS.filter((a) => a.side === 'left');
    expect(minMapHeight(left)).toBeCloseTo((44 * 720) / 75, 5);
  });
});
