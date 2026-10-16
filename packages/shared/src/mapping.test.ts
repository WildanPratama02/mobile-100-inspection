import { describe, expect, it } from 'vitest';
import { createMappingIndex, defaultMapping, fromMappingJson, type RawMapping } from './mapping';

const ids = (items: readonly { id: string }[]) => items.map((i) => i.id);
const range = (prefix: string, from: number, to: number, width: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => prefix + String(from + i).padStart(width, '0'));

describe('defaultMapping (reference/mapping/mapping.json)', () => {
  const m = defaultMapping();

  it('has the 12 areas A01–A12 in display order', () => {
    expect(ids(m.areas)).toEqual(range('A', 1, 12, 2));
    expect(m.areas.map((a) => a.order)).toEqual(range('', 1, 12, 1).map(Number));
  });

  it('has the 98 defects D001–D098', () => {
    expect(ids(m.defects)).toEqual(range('D', 1, 98, 3));
  });

  it('keeps D049 and D071 apart although they share a name (ADR-009)', () => {
    const d049 = m.defect('D049');
    const d071 = m.defect('D071');
    expect(d049?.name).toBe('POOR TOUCH UP/PAINTING, MARKING LINE');
    expect(d071?.name).toBe(d049?.name);
    expect(d049?.familyId).toBe('F05');
    expect(d071?.familyId).toBe('F11');
    expect(d049?.classification).toBe('MINOR');
    expect(d071?.classification).toBe('MINOR');
  });

  it('offers the same families and defects in Medial Quarter as in Lateral Quarter (AC-07.1)', () => {
    const offer = (subAreaId: string) =>
      m.familiesOf(subAreaId).map((f) => [f.id, ids(m.defectsOf(subAreaId, f.id))]);
    expect(offer('SA03L').length).toBeGreaterThan(0);
    expect(offer('SA03M')).toEqual(offer('SA03L'));
  });

  it('has 437 map entries that reference known families and defects, covering every defect', () => {
    expect(m.map).toHaveLength(437);
    for (const e of m.map) {
      expect(m.family(e.familyId)).toBeDefined();
      expect(m.defect(e.defectId)).toBeDefined();
    }
    expect(new Set(m.map.map((e) => e.defectId)).size).toBe(98);
  });

  it('maps classification codes to MINOR / MAJOR / CRITICAL', () => {
    expect(m.defect('D049')?.classification).toBe('MINOR');
    expect(m.defect('D035')?.classification).toBe('MAJOR');
    expect(m.defect('D005')?.classification).toBe('CRITICAL');
    const count = (c: string) => m.defects.filter((d) => d.classification === c).length;
    expect([count('MINOR'), count('MAJOR'), count('CRITICAL')]).toEqual([44, 44, 10]);
  });

  it('does not offer a sub-area without mapped defects (SA10T Midsole Top Line)', () => {
    expect(ids(m.subAreasOf('A10'))).toEqual(['SA10M']);
    expect(m.subArea('SA10T')).toBeUndefined();
  });

  it('lists sub-areas, families and defects in mapping order', () => {
    expect(ids(m.subAreasOf('A03'))).toEqual(['SA03L', 'SA03M']);
    expect(m.subArea('SA03L')?.order).toBe(3);
    expect(m.subArea('SA11O')?.order).toBe(26);
    expect(ids(m.familiesOf('SA01')).slice(0, 3)).toEqual(['F03', 'F01', 'F06']);
    expect(ids(m.defectsOf('SA11T', 'F03')).at(-1)).toBe('D072');
  });

  it('returns undefined or an empty list for unknown ids', () => {
    expect(m.area('A13')).toBeUndefined();
    expect(m.subArea('SA99')).toBeUndefined();
    expect(m.family('F99')).toBeUndefined();
    expect(m.defect('D099')).toBeUndefined();
    expect(m.subAreasOf('A13')).toEqual([]);
    expect(m.familiesOf('SA99')).toEqual([]);
    expect(m.defectsOf('SA03L', 'F99')).toEqual([]);
  });

  it('is built once', () => {
    expect(defaultMapping()).toBe(m);
  });
});

describe('fromMappingJson and createMappingIndex', () => {
  const raw = (): RawMapping => ({
    areas: [
      {
        id: 'A01',
        name: 'Toe Box',
        subs: [{ id: 'SA01', name: 'Toe Box', fams: [['F01', ['D001']]] }],
      },
    ],
    families: { F01: 'Material' },
    defects: { D001: { n: 'DEFECT ONE', c: 2, f: 'F01' } },
  });

  it('builds an index from a valid mapping', () => {
    const m = createMappingIndex(fromMappingJson(raw()));
    expect(ids(m.defectsOf('SA01', 'F01'))).toEqual(['D001']);
  });

  it('rejects an unknown classification code', () => {
    const r = raw();
    r.defects.D001 = { n: 'DEFECT ONE', c: 4, f: 'F01' };
    expect(() => fromMappingJson(r)).toThrow(/unknown classification code 4/);
  });

  it('rejects a map entry with an unknown defect', () => {
    const r = raw();
    r.areas[0]!.subs[0]!.fams = [['F01', ['D001', 'D002']]];
    expect(() => createMappingIndex(fromMappingJson(r))).toThrow(/unknown defect/);
  });

  it('rejects a map entry with an unknown family', () => {
    const r = raw();
    r.areas[0]!.subs[0]!.fams = [['F02', ['D001']]];
    expect(() => createMappingIndex(fromMappingJson(r))).toThrow(/unknown family/);
  });
});
