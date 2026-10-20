import { useEffect } from 'react';
import { DataSourcesContext, useDataSources } from './app/dataSources';
import './app/app.css';
import { useApplyUpdateWhenIdle } from './app/appUpdate';
import { ToastProvider } from './app/toast';
import { useWakeLock } from './app/useWakeLock';
import type { DataSources } from './data/sources';
import { DefectScreen } from './screens/DefectScreen';
import { HomeScreen } from './screens/HomeScreen';
import { LoginScreen } from './screens/LoginScreen';
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
  /** Tests pass their own; the app uses `getAppStore()` and the Phase 1 fixtures. */
  store?: AppStore;
  sources?: DataSources;
}

export function App({ store, sources }: AppProps) {
  const fixtures = useDataSources();
  return (
    <DataSourcesContext.Provider value={sources ?? fixtures}>
      <AppStoreContext.Provider value={store ?? getAppStore()}>
        <ToastProvider>
          <Screens />
        </ToastProvider>
      </AppStoreContext.Provider>
    </DataSourcesContext.Provider>
  );
}

/**
 * Which full screen shows (doc 05 §2): logged in → Home, or the Defect screen if the PSI was on it; otherwise
 * Login, or Start while data loads. The screen stays on while any inspection is active (G10).
 */
function Screens() {
  const store = useAppStoreApi();
  const { masterData } = useDataSources();
  const status = useAppStore((s) => s.status);
  const auth = useAppStore((s) => s.auth);
  const loginData = useAppStore((s) => s.loginData);
  const loginDataStatus = useAppStore((s) => s.loginDataStatus);
  const screen = useAppStore((s) => s.view.screen);
  const po = useAppStore(selectedPo);
  const inspecting = useAppStore((s) =>
    Object.values(s.sessions).some((session) => session.state.active),
  );
  useWakeLock(inspecting);
  // A new version takes over only on Login, or on Home with no inspection active (doc 03 §4.8).
  useApplyUpdateWhenIdle(status !== 'loading' && (!auth || (screen !== 'defect' && !inspecting)));

  useEffect(() => {
    // Restore the logged-in PSI's POs, sessions and screen from IndexedDB (doc 03 §4.3).
    store.getState().hydrate().catch(console.error);
    // Cached copy at once, refreshed in the background (doc 05 §6 warm start).
    void store.getState().loadLoginData(masterData);
  }, [store, masterData]);

  if (status === 'loading') return <main className="app-screen" />;
  // The Defect screen needs a selected PO (doc 05 §11); without one the PSI is back on Home.
  if (auth && screen === 'defect' && po) return <DefectScreen po={po} />;
  if (auth) return <HomeScreen auth={auth} />;
  if (loginData) return <LoginScreen data={loginData} />;
  return (
    <StartScreen
      failed={loginDataStatus === 'failed'}
      onRetry={() => void store.getState().loadLoginData(masterData)}
    />
  );
}
