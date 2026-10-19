import { defaultMapping, type Finding, type RecordedDefect } from '@m100/shared';
import { describe, expect, it } from 'vitest';
import {
  NO_PATH,
  areaCounts,
  countWhere,
  crumbs,
  defectCountOf,
  historyPath,
  levelOf,
  selectArea,
  selectFamily,
  selectSubArea,
  up,
} from './drilldown';

const mapping = defaultMapping();

describe('drill-down with auto-skip (BR-08)', () => {
  it('opens an area with several sub-areas at its sub-areas', () => {
    const path = selectArea(mapping, 'A03');
    expect(path).toEqual({ areaId: 'A03', subAreaId: null, familyId: null });
    expect(levelOf(path)).toBe(1);
  });

  it('skips the sub-area level of an area with one sub-area (Toe Box)', () => {
    const path = selectArea(mapping, 'A01');
    expect(path).toEqual({ areaId: 'A01', subAreaId: 'SA01', familyId: null });
    expect(levelOf(path)).toBe(2);
  });

  it('skips the family level of a sub-area with one family (Heel Counter / Back Tab)', () => {
    const [family] = mapping.familiesOf('SA04C');
    const path = selectSubArea(mapping, 'A04', 'SA04C');
    expect(path).toEqual({ areaId: 'A04', subAreaId: 'SA04C', familyId: family!.id });
    expect(levelOf(path)).toBe(3);
  });

  it('goes up one level at a time where nothing was skipped', () => {
    const family = mapping.familiesOf('SA03M')[0]!.id;
    const defects = selectFamily(selectSubArea(mapping, 'A03', 'SA03M'), family);
    const families = up(mapping, defects)!;
    expect(families).toEqual({ areaId: 'A03', subAreaId: 'SA03M', familyId: null });
    const subs = up(mapping, families)!;
    expect(subs).toEqual({ areaId: 'A03', subAreaId: null, familyId: null });
    expect(up(mapping, subs)).toEqual(NO_PATH);
    expect(up(mapping, NO_PATH)).toBeNull();
  });

  it('skips the levels BACK would land on with one option', () => {
    // Heel Counter has one family: from its defects BACK goes straight to Heel's sub-areas.
    expect(up(mapping, selectSubArea(mapping, 'A04', 'SA04C'))).toEqual({
      areaId: 'A04',
      subAreaId: null,
      familyId: null,
    });
    // Toe Box has one sub-area: from its families BACK leaves the area.
    expect(up(mapping, selectArea(mapping, 'A01'))).toEqual(NO_PATH);
    const family = mapping.familiesOf('SA01')[0]!.id;
    expect(up(mapping, selectFamily(selectArea(mapping, 'A01'), family))).toEqual(
      selectArea(mapping, 'A01'),
    );
  });

  it('leaves skipped levels out of the breadcrumb, and each crumb goes to its level (FR-07.5)', () => {
    const family = mapping.familiesOf('SA03M')[0]!;
    const path = selectFamily(selectSubArea(mapping, 'A03', 'SA03M'), family.id);
    const list = crumbs(mapping, path);
    expect(list.map((c) => c.label)).toEqual(['Quarter', 'Medial Quarter', family.name]);
    expect(list[0]!.path).toEqual(selectArea(mapping, 'A03'));
    expect(list[1]!.path).toEqual({ areaId: 'A03', subAreaId: 'SA03M', familyId: null });

    expect(crumbs(mapping, selectArea(mapping, 'A01')).map((c) => c.label)).toEqual(['Toe Box']);
    expect(crumbs(mapping, selectSubArea(mapping, 'A04', 'SA04C')).map((c) => c.label)).toEqual([
      'Heel',
      'Heel Counter / Back Tab',
    ]);
    expect(crumbs(mapping, NO_PATH)).toEqual([]);
  });

  it('offers the same families and defects in Medial Quarter as in Lateral Quarter (AC-07.1)', () => {
    const lateral = mapping.familiesOf('SA03L');
    expect(mapping.familiesOf('SA03M')).toEqual(lateral);
    for (const f of lateral) {
      expect(mapping.defectsOf('SA03M', f.id)).toEqual(mapping.defectsOf('SA03L', f.id));
    }
    expect(defectCountOf(mapping, 'SA03M')).toBe(defectCountOf(mapping, 'SA03L'));
  });
});

describe('counts and history', () => {
  const entries = mapping.map.filter((e) => e.subAreaId === 'SA03M');
  const [a, b] = entries;
  const toe = mapping.map.find((e) => e.areaId === 'A01')!;
  const rec = (e: typeof toe): RecordedDefect => ({
    ...e,
    inspectionType: 'REWORK',
    at: '2026-10-19T01:00:00.000Z',
  });
  const defects = [rec(a!), rec(a!), rec(b!), rec(toe)];

  it('counts per area, sub-area, family and defect (FR-07.6, AC-07.3)', () => {
    expect(areaCounts(defects)).toEqual({ A03: 3, A01: 1 });
    expect(countWhere(defects, { subAreaId: 'SA03M' })).toBe(3);
    expect(countWhere(defects, { subAreaId: 'SA03L' })).toBe(0);
    expect(countWhere(defects, { subAreaId: 'SA03M', defectId: a!.defectId })).toBe(2);
    expect(countWhere(defects, { subAreaId: 'SA03M', familyId: a!.familyId })).toBe(
      a!.familyId === b!.familyId ? 3 : 2,
    );
  });

  it('writes the history path as Area › Sub-area · Family · TYPE', () => {
    const finding = (e: typeof toe, type: Finding['inspectionType']): Finding => ({
      ...e,
      inspectionType: type,
      qty: 1,
      firstRecordedAt: '2026-10-19T01:00:00.000Z',
    });
    const fam = mapping.family(a!.familyId)!.name;
    expect(historyPath(mapping, finding(a!, 'B-GRADE'))).toBe(
      `Quarter › Medial Quarter · ${fam} · B-GRADE`,
    );
    // Toe Box has one sub-area, so it is not repeated.
    expect(historyPath(mapping, finding(toe, 'REWORK'))).toBe(
      `Toe Box · ${mapping.family(toe.familyId)!.name} · REWORK`,
    );
  });
});
