/**
 * Area → sub-area → family → defect mapping (ADR-009, AC-07.1).
 *
 * `fromMappingJson` reads the bundled `reference/mapping/mapping.json` (generated from
 * Footwear_Defect_Mapping_Database_v2.xlsx); `createMappingIndex` builds the lookups the
 * drill-down uses. Phase 2 feeds `GET /master-data` into the same index, so screens do not
 * depend on where the mapping came from. Defects are keyed by DEFECT_ID only: D049 and D071
 * share a name.
 */
import mappingJson from '../../../reference/mapping/mapping.json';
import type {
  Area,
  AreaId,
  AreaMapEntry,
  Classification,
  Defect,
  DefectId,
  Family,
  SubArea,
} from './domain';

/** Shape of `reference/mapping/mapping.json`. */
export interface RawMapping {
  areas: {
    id: string;
    name: string;
    subs: { id: string; name: string; fams: [familyId: string, defectIds: string[]][] }[];
  }[];
  families: Record<string, string>;
  /** `n` name, `c` classification code, `f` family id. */
  defects: Record<string, { n: string; c: number; f: string }>;
}

/** Classification codes of mapping.json (D049 is code 1 and MINOR, doc 02 §3.4). */
export const CLASSIFICATION_BY_CODE: Readonly<Record<number, Classification>> = {
  1: 'MINOR',
  2: 'MAJOR',
  3: 'CRITICAL',
};

/** The mapping part of the `/master-data` document, without `mapId`. */
export interface MappingData {
  areas: Area[];
  families: Family[];
  defects: Defect[];
  map: AreaMapEntry[];
}

/**
 * Converts mapping.json into `MappingData`. Area order is the position (1–12); sub-area order
 * is the position across all sub-areas, as SUB_AREA_ORDER in the sheet. Sub-areas without any
 * mapped defect are left out: M100_AREA_MAP has one row per mapping, so the API cannot offer
 * them either.
 */
export function fromMappingJson(raw: RawMapping): MappingData {
  const defects = Object.entries(raw.defects).map(([id, d]): Defect => {
    const classification = CLASSIFICATION_BY_CODE[d.c];
    if (!classification) {
      throw new Error(`Mapping: defect ${id} has unknown classification code ${d.c}`);
    }
    return { id: id as DefectId, name: d.n, classification, familyId: d.f };
  });
  const families = Object.entries(raw.families).map(([id, name]): Family => ({ id, name }));

  const map: AreaMapEntry[] = [];
  let subAreaOrder = 0;
  const areas = raw.areas.map((a, i): Area => {
    const areaId = a.id as AreaId;
    const subAreas: SubArea[] = [];
    for (const s of a.subs) {
      subAreaOrder += 1;
      const entries = s.fams.flatMap(([familyId, defectIds]) =>
        defectIds.map((defectId): AreaMapEntry => ({
          areaId,
          subAreaId: s.id,
          familyId,
          defectId: defectId as DefectId,
        })),
      );
      if (entries.length === 0) continue;
      subAreas.push({ id: s.id, name: s.name, order: subAreaOrder });
      map.push(...entries);
    }
    return { id: areaId, name: a.name, order: i + 1, subAreas };
  });

  return { areas, families, defects, map };
}

/** Typed lookups over one mapping. Lists keep the display order; unknown ids give `undefined`. */
export interface MappingIndex {
  readonly areas: readonly Area[];
  readonly families: readonly Family[];
  readonly defects: readonly Defect[];
  readonly map: readonly AreaMapEntry[];
  area(id: string): Area | undefined;
  subArea(id: string): SubArea | undefined;
  family(id: string): Family | undefined;
  defect(id: string): Defect | undefined;
  /** Sub-areas of an area that have at least one mapped defect. */
  subAreasOf(areaId: string): readonly SubArea[];
  /** Families offered in a sub-area, in mapping order. */
  familiesOf(subAreaId: string): readonly Family[];
  /** Defects offered in a sub-area and family, in mapping order. */
  defectsOf(subAreaId: string, familyId: string): readonly Defect[];
}

function byId<T extends { id: string }>(items: readonly T[], what: string): Map<string, T> {
  const index = new Map<string, T>();
  for (const item of items) {
    if (index.has(item.id)) throw new Error(`Mapping: duplicate ${what} ${item.id}`);
    index.set(item.id, item);
  }
  return index;
}

function pushTo<K, V>(index: Map<K, V[]>, key: K, value: V): void {
  const list = index.get(key);
  if (list) list.push(value);
  else index.set(key, [value]);
}

/** Builds the lookups and checks that every map entry points at known, consistent ids. */
export function createMappingIndex(data: MappingData): MappingIndex {
  const areas = [...data.areas]
    .sort((a, b) => a.order - b.order)
    .map((a) => ({ ...a, subAreas: [...a.subAreas].sort((x, y) => x.order - y.order) }));
  const areaById = byId(areas, 'area');
  const subAreaById = byId(
    areas.flatMap((a) => a.subAreas),
    'sub-area',
  );
  const areaIdOfSubArea = new Map<string, string>();
  for (const a of areas) for (const s of a.subAreas) areaIdOfSubArea.set(s.id, a.id);
  const familyById = byId(data.families, 'family');
  const defectById = byId(data.defects, 'defect');

  const familiesBySubArea = new Map<string, Family[]>();
  const defectsBySubAreaFamily = new Map<string, Defect[]>();
  const subAreasWithDefects = new Set<string>();
  for (const e of data.map) {
    const where = `${e.areaId}/${e.subAreaId}/${e.familyId}/${e.defectId}`;
    if (!areaById.has(e.areaId)) throw new Error(`Mapping: unknown area in ${where}`);
    if (areaIdOfSubArea.get(e.subAreaId) !== e.areaId) {
      throw new Error(`Mapping: sub-area does not belong to its area in ${where}`);
    }
    const family = familyById.get(e.familyId);
    if (!family) throw new Error(`Mapping: unknown family in ${where}`);
    const defect = defectById.get(e.defectId);
    if (!defect) throw new Error(`Mapping: unknown defect in ${where}`);

    subAreasWithDefects.add(e.subAreaId);
    const families = familiesBySubArea.get(e.subAreaId);
    if (!families?.includes(family)) pushTo(familiesBySubArea, e.subAreaId, family);
    pushTo(defectsBySubAreaFamily, `${e.subAreaId}|${e.familyId}`, defect);
  }

  const subAreasByArea = new Map<string, SubArea[]>(
    areas.map((a) => [a.id, a.subAreas.filter((s) => subAreasWithDefects.has(s.id))]),
  );

  return {
    areas,
    families: data.families,
    defects: data.defects,
    map: data.map,
    area: (id) => areaById.get(id),
    subArea: (id) => subAreaById.get(id),
    family: (id) => familyById.get(id),
    defect: (id) => defectById.get(id),
    subAreasOf: (areaId) => subAreasByArea.get(areaId) ?? [],
    familiesOf: (subAreaId) => familiesBySubArea.get(subAreaId) ?? [],
    defectsOf: (subAreaId, familyId) =>
      defectsBySubAreaFamily.get(`${subAreaId}|${familyId}`) ?? [],
  };
}

let bundled: MappingIndex | undefined;

/** The mapping bundled with the app (offline fallback, doc 03 §4.1). Built once. */
export function defaultMapping(): MappingIndex {
  // JSON imports are typed loosely (tuples become arrays); fromMappingJson checks the content.
  bundled ??= createMappingIndex(fromMappingJson(mappingJson as unknown as RawMapping));
  return bundled;
}
