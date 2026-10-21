import { createContext, useContext } from 'react';
import {
  createMappingIndex,
  defaultMapping,
  type AreaId,
  type MappingIndex,
  type MasterData,
} from '@m100/shared';
import { SHOE_AREAS } from '../ui/shoeLayout';

/** The mapping of the cached `/master-data` document (AC-13.1); the bundled one until there is one. */
export const MappingContext = createContext<MappingIndex>(defaultMapping());

/**
 * The area map of a `/master-data` document. Without a document, or with one whose map does not hold together,
 * the mapping bundled with the app (the offline fallback, doc 03 §4.1).
 *
 * The document lists active rows only, but a defect tapped before it was deactivated stays in its session and is
 * still accepted on submit (doc 04 §4.2 rule 4). So the lists that offer new taps come from the document, while
 * looking up an id the document no longer has falls back to the bundled mapping.
 */
export function mappingOf(masterData: MasterData | null): MappingIndex {
  const bundled = defaultMapping();
  if (!masterData) return bundled;
  let index: MappingIndex;
  try {
    index = createMappingIndex(masterData);
  } catch (error) {
    console.error(error);
    return bundled;
  }
  return {
    ...index,
    area: (id) => index.area(id) ?? bundled.area(id),
    subArea: (id) => index.subArea(id) ?? bundled.subArea(id),
    family: (id) => index.family(id) ?? bundled.family(id),
    defect: (id) => index.defect(id) ?? bundled.defect(id),
  };
}

export function useMapping(): MappingIndex {
  return useContext(MappingContext);
}

/** Area names as on the shoe map pills ("VAMP, TOE BOX"; doc 05 §8.3). */
const AREA_LABEL = new Map(SHOE_AREAS.map((a) => [a.id, a.lines.join(' ')]));

/** The areas of a Top 5 row, as Home and the exports show them. */
export function areaLabels(ids: readonly AreaId[], mapping: MappingIndex): string {
  return ids.map((id) => AREA_LABEL.get(id) ?? mapping.area(id)?.name ?? id).join(', ');
}
