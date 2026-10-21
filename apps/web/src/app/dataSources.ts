import { createContext, useContext } from 'react';
import type { DataSources } from '../data/sources';

/** The API (`createApiSources`), given by `App`; Vitest gives the fixtures. */
export const DataSourcesContext = createContext<DataSources | null>(null);

export function useDataSources(): DataSources {
  const sources = useContext(DataSourcesContext);
  if (!sources) throw new Error('useDataSources needs a DataSourcesContext provider');
  return sources;
}
