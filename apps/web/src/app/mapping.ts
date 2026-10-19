import { createContext, useContext } from 'react';
import { defaultMapping, type MappingIndex } from '@m100/shared';

/** Phase 1: the mapping bundled with the app. T2.6 provides the one from `GET /master-data` here instead. */
export const MappingContext = createContext<MappingIndex>(defaultMapping());

export function useMapping(): MappingIndex {
  return useContext(MappingContext);
}
