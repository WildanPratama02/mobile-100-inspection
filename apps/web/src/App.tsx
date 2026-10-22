import { useEffect, useMemo, useState } from 'react';
import { createApiSources } from './api/apiSources';
import { DataSourcesContext, useDataSources } from './app/dataSources';
import './app/app.css';
import { useApplyUpdateWhenIdle } from './app/appUpdate';
import { MappingContext, mappingOf } from './app/mapping';
import { ToastProvider } from './app/toast';
import { useMasterDataRefresh } from './app/useMasterDataRefresh';
import { useWakeLock } from './app/useWakeLock';
import type { DataSources } from './data/sources';
import { createOutboxSender } from './outbox/sender';
import {
  OutboxSenderContext,
  useFailedOutboxToast,
  useOutboxSender,
  useOutboxSenderLoop,
} from './outbox/useOutboxSender';
import { DefectScreen } from './screens/DefectScreen';
import { HomeScreen } from './screens/HomeScreen';
import { LoginScreen } from './screens/LoginScreen';
import { SETUP_PATH } from './app/setupLink';
import { NotRegisteredScreen, SetupScreen } from './screens/SetupScreen';
import { StartScreen } from './screens/StartScreen';
import {
  AppStoreContext,
  getAppStore,
  selectedPo,
  useAppStore,
  useAppStoreApi,
  type AppStore,
} from './state/store';

export interface AppProps {
  /** Tests pass their own; the app uses `getAppStore()` and the API. */
  store?: AppStore;
  sources?: DataSources;
}

export function App({ store, sources }: AppProps) {
  const appStore = store ?? getAppStore();
  const dataSources = useMemo(() => sources ?? createApiSources(appStore), [sources, appStore]);
  // One sender per tablet: every author's items, each with its author's token (doc 03 §4.4).
  const sender = useMemo(
    () =>
      createOutboxSender({
        db: appStore.db,
        deviceKey: () => appStore.getState().deviceKey,
        refresh: (token) => dataSources.auth.refresh(token),
        onChange: () => void appStore.getState().reloadOutbox().catch(console.error),
      }),
    [appStore, dataSources],
  );
  return (
    <DataSourcesContext.Provider value={dataSources}>
      <AppStoreContext.Provider value={appStore}>
        <OutboxSenderContext.Provider value={sender}>
          <ToastProvider>
            <Screens />
          </ToastProvider>
        </OutboxSenderContext.Provider>
      </AppStoreContext.Provider>
    </DataSourcesContext.Provider>
  );
}

/**
 * Which full screen shows (doc 05 §2): the setup page at `/setup` (S0); a tablet without a device key gets only
 * the "not registered" screen; logged in → Home, or the Defect screen if the PSI was on it; otherwise Login, or
 * Start while master data loads. The screen stays on while any inspection is active (G10).
 */
function Screens() {
  const store = useAppStoreApi();
  const sources = useDataSources();
  const [onSetup] = useState(() => window.location.pathname === SETUP_PATH);
  const status = useAppStore((s) => s.status);
  const deviceKey = useAppStore((s) => s.deviceKey);
  const auth = useAppStore((s) => s.auth);
  const masterData = useAppStore((s) => s.masterData);
  const masterDataStatus = useAppStore((s) => s.masterDataStatus);
  const masterDataProblem = useAppStore((s) => s.masterDataProblem);
  const screen = useAppStore((s) => s.view.screen);
  const po = useAppStore(selectedPo);
  const inspecting = useAppStore((s) =>
    Object.values(s.sessions).some((session) => session.state.active),
  );
  const mapping = useMemo(() => mappingOf(masterData), [masterData]);
  useWakeLock(inspecting);
  // A new version takes over only on Login, or on Home with no inspection active (doc 03 §4.8).
  useApplyUpdateWhenIdle(status !== 'loading' && (!auth || (screen !== 'defect' && !inspecting)));
  // Cached copy at once, refreshed in the background (doc 05 §6 warm start).
  useMasterDataRefresh(!onSetup && status === 'ready' && deviceKey !== null);
  // Sealed submissions go while the app is open, logged in or not (doc 03 §4.6).
  useOutboxSenderLoop(useOutboxSender(), !onSetup && status === 'ready' && deviceKey !== null);
  useFailedOutboxToast();

  useEffect(() => {
    // Restore the device key and the logged-in PSI's POs, sessions and screen from IndexedDB (doc 03 §4.3).
    store.getState().hydrate().catch(console.error);
  }, [store]);

  if (onSetup) return <SetupScreen />;
  if (status === 'loading') return <main className="app-screen" />;
  if (!deviceKey) return <NotRegisteredScreen />;
  return (
    <MappingContext.Provider value={mapping}>
      {auth && screen === 'defect' && po ? (
        // The Defect screen needs a selected PO (doc 05 §11); without one the PSI is back on Home.
        <DefectScreen po={po} />
      ) : auth ? (
        <HomeScreen auth={auth} />
      ) : masterData ? (
        <LoginScreen data={masterData} />
      ) : (
        <StartScreen
          failed={masterDataStatus === 'failed'}
          problem={masterDataProblem}
          onRetry={() => void store.getState().loadMasterData(sources.masterData)}
        />
      )}
    </MappingContext.Provider>
  );
}
