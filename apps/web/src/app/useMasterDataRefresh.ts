import { useEffect } from 'react';
import { useAppStoreApi } from '../state/store';
import { useDataSources } from './dataSources';

/** How often master data is checked while the app is open (AC-13.2). */
export const MASTER_DATA_REFRESH_MS = 30 * 60 * 1000;

/**
 * Checks master data, and renews the PSI's token when fewer than 7 days remain (doc 04 §2): when the app opens,
 * every 30 minutes while it is open, and when the connection comes back after a failed check (AC-13.2, doc 03
 * §4.7). Only once the tablet has a device key: the API answers nothing without one.
 */
export function useMasterDataRefresh(enabled: boolean): void {
  const store = useAppStoreApi();
  const { masterData, auth } = useDataSources();

  useEffect(() => {
    if (!enabled) return;
    let failed = false;
    const refresh = () => {
      void store
        .getState()
        .loadMasterData(masterData)
        .then((ok) => {
          failed = !ok;
        });
      store
        .getState()
        .renewToken(auth)
        .catch((error: unknown) => console.error(error));
    };
    const onOnline = () => {
      if (failed) refresh();
    };
    refresh();
    const timer = window.setInterval(refresh, MASTER_DATA_REFRESH_MS);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', onOnline);
    };
  }, [enabled, store, masterData, auth]);
}
