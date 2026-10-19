import { createContext, useContext } from 'react';
import { defaultMapping, type AreaId, type MappingIndex } from '@m100/shared';
import { SHOE_AREAS } from '../ui/shoeLayout';

/** Phase 1: the mapping bundled with the app. T2.6 provides the one from `GET /master-data` here instead. */
export const MappingContext = createContext<MappingIndex>(defaultMapping());

export function useMapping(): MappingIndex {
  return useContext(MappingContext);
}

/** Area names as on the shoe map pills ("VAMP, TOE BOX"; doc 05 §8.3). */
const AREA_LABEL = new Map(SHOE_AREAS.map((a) => [a.id, a.lines.join(' ')]));

/** The areas of a Top 5 row, as Home and the exports show them. */
export function areaLabels(ids: readonly AreaId[], mapping: MappingIndex): string {
  return ids.map((id) => AREA_LABEL.get(id) ?? mapping.area(id)?.name ?? id).join(', ');
}
