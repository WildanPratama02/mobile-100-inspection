import { createContext, useContext } from 'react';
import { createFixtureSources } from '../data/fixtures/fixtureSources';
import type { DataSources } from '../data/sources';

/** Phase 1: the fixtures. T2.6 provides the API implementation here instead. */
export const DataSourcesContext = createContext<DataSources>(createFixtureSources());

export function useDataSources(): DataSources {
  return useContext(DataSourcesContext);
}
