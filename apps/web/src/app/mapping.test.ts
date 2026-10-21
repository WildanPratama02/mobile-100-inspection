import { defaultMapping } from '@m100/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureMasterData } from '../data/fixtures/fixtureSources';
import { mappingOf } from './mapping';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mappingOf (AC-13.1, doc 03 §4.1)', () => {
  it('is the bundled mapping until master data is cached', () => {
    expect(mappingOf(null)).toBe(defaultMapping());
  });

  it('offers what the document lists', () => {
    const doc = fixtureMasterData();
    // Defect D001 deactivated: the API leaves it and its map rows out.
    doc.defects = doc.defects.filter((d) => d.id !== 'D001');
    doc.map = doc.map.filter((m) => m.defectId !== 'D001');
    const mapping = mappingOf(doc);
    expect(mapping.defects.some((d) => d.id === 'D001')).toBe(false);
    const where = defaultMapping().map.find((m) => m.defectId === 'D001')!;
    expect(mapping.defectsOf(where.subAreaId, where.familyId).map((d) => d.id)).not.toContain(
      'D001',
    );
  });

  it('still names a defect tapped before it was deactivated (doc 04 §4.2 rule 4)', () => {
    const doc = fixtureMasterData();
    doc.defects = doc.defects.filter((d) => d.id !== 'D001');
    doc.map = doc.map.filter((m) => m.defectId !== 'D001');
    expect(mappingOf(doc).defect('D001')).toEqual(defaultMapping().defect('D001'));
  });

  it('falls back to the bundled mapping when the document does not hold together', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const doc = fixtureMasterData();
    doc.defects = [];
    expect(mappingOf(doc)).toBe(defaultMapping());
  });
});
