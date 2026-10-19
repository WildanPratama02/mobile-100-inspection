/**
 * The Defect screen's drill-down (FR-07, doc 05 §11.3): area → sub-area → family → defect, with the levels that
 * have exactly one option selected automatically and skipped by BACK and the breadcrumb (BR-08). Counts are of the
 * active inspection only (FR-07.6, AC-07.3). Everything here is pure.
 */
import type { AreaId, Finding, MappingIndex, RecordedDefect } from '@m100/shared';
import type { DefectPath } from '../db/schema';

export const NO_PATH: DefectPath = { areaId: null, subAreaId: null, familyId: null };

/** 0 no area, 1 sub-areas of the area, 2 families of the sub-area, 3 defects of the family. */
export type Level = 0 | 1 | 2 | 3;

export function levelOf(path: DefectPath): Level {
  if (!path.areaId) return 0;
  if (!path.subAreaId) return 1;
  if (!path.familyId) return 2;
  return 3;
}

const onlySubArea = (mapping: MappingIndex, areaId: string) => {
  const subs = mapping.subAreasOf(areaId);
  return subs.length === 1 ? subs[0] : undefined;
};

const onlyFamily = (mapping: MappingIndex, subAreaId: string) => {
  const families = mapping.familiesOf(subAreaId);
  return families.length === 1 ? families[0] : undefined;
};

/** Opens a sub-area: its families, or its defects when it has only one family. */
export function selectSubArea(
  mapping: MappingIndex,
  areaId: AreaId,
  subAreaId: string,
): DefectPath {
  return { areaId, subAreaId, familyId: onlyFamily(mapping, subAreaId)?.id ?? null };
}

/** Opens an area from its pill; a different area replaces the path (doc 05 §11.3). */
export function selectArea(mapping: MappingIndex, areaId: AreaId): DefectPath {
  const sub = onlySubArea(mapping, areaId);
  return sub ? selectSubArea(mapping, areaId, sub.id) : { areaId, subAreaId: null, familyId: null };
}

export function selectFamily(path: DefectPath, familyId: string): DefectPath {
  return { ...path, familyId };
}

/**
 * BACK (FR-08): one level up, past any level that was skipped on the way down. `null` at level 0, where BACK
 * returns to Home.
 */
export function up(mapping: MappingIndex, path: DefectPath): DefectPath | null {
  const { areaId, subAreaId, familyId } = path;
  if (!areaId) return null;
  if (subAreaId && familyId && !onlyFamily(mapping, subAreaId)) {
    return { areaId, subAreaId, familyId: null };
  }
  if (subAreaId && !onlySubArea(mapping, areaId))
    return { areaId, subAreaId: null, familyId: null };
  return NO_PATH;
}

export interface Crumb {
  label: string;
  /** Where tapping the crumb goes (FR-07.5). */
  path: DefectPath;
}

/** Area › sub-area › family, leaving out the levels that were skipped (Breadcrumb README). */
export function crumbs(mapping: MappingIndex, path: DefectPath): Crumb[] {
  const { areaId, subAreaId, familyId } = path;
  if (!areaId) return [];
  const list: Crumb[] = [
    { label: mapping.area(areaId)?.name ?? areaId, path: selectArea(mapping, areaId) },
  ];
  if (subAreaId && !onlySubArea(mapping, areaId)) {
    list.push({
      label: mapping.subArea(subAreaId)?.name ?? subAreaId,
      path: selectSubArea(mapping, areaId, subAreaId),
    });
  }
  if (subAreaId && familyId && !onlyFamily(mapping, subAreaId)) {
    list.push({ label: mapping.family(familyId)?.name ?? familyId, path });
  }
  return list;
}

/** Number of defects a sub-area offers, for the "N defect" sub-line. */
export function defectCountOf(mapping: MappingIndex, subAreaId: string): number {
  return mapping
    .familiesOf(subAreaId)
    .reduce((n, f) => n + mapping.defectsOf(subAreaId, f.id).length, 0);
}

/** Defects recorded per area in the active inspection, for the shoe-map pills (FR-07.6). */
export function areaCounts(defects: readonly RecordedDefect[]): Partial<Record<AreaId, number>> {
  const counts: Partial<Record<AreaId, number>> = {};
  for (const d of defects) counts[d.areaId] = (counts[d.areaId] ?? 0) + 1;
  return counts;
}

/** Defects recorded in the active inspection that match every given field. */
export function countWhere(
  defects: readonly RecordedDefect[],
  match: Partial<Pick<RecordedDefect, 'areaId' | 'subAreaId' | 'familyId' | 'defectId'>>,
): number {
  const fields = Object.entries(match) as Array<[keyof RecordedDefect, string]>;
  return defects.filter((d) => fields.every(([k, v]) => d[k] === v)).length;
}

/** The history grain (AC-09.2): inspection type + area + sub-area + defect, as `findings` groups them. */
export function historyKey(
  f: Pick<Finding, 'inspectionType' | 'areaId' | 'subAreaId' | 'defectId'>,
) {
  return [f.inspectionType, f.areaId, f.subAreaId, f.defectId].join('|');
}

/** "Area › Sub-area · Family · TYPE"; the sub-area is left out when the area has only one. */
export function historyPath(mapping: MappingIndex, f: Finding): string {
  const area = mapping.area(f.areaId)?.name ?? f.areaId;
  const where = onlySubArea(mapping, f.areaId)
    ? area
    : `${area} › ${mapping.subArea(f.subAreaId)?.name ?? f.subAreaId}`;
  return `${where} · ${mapping.family(f.familyId)?.name ?? f.familyId} · ${f.inspectionType}`;
}
