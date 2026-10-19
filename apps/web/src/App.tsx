import { useEffect } from 'react';
import { DataSourcesContext, useDataSources } from './app/dataSources';
import './app/app.css';
import { ToastProvider } from './app/toast';
import type { DataSources } from './data/sources';
import { HomeScreen } from './screens/HomeScreen';
import { LoginScreen } from './screens/LoginScreen';
import { StartScreen } from './screens/StartScreen';
import {
  AppStoreContext,
  getAppStore,
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

/** Which full screen shows (doc 05 §2): logged in → Home; otherwise Login, or Start while data loads. */
function Screens() {
  const store = useAppStoreApi();
  const { masterData } = useDataSources();
  const status = useAppStore((s) => s.status);
  const auth = useAppStore((s) => s.auth);
  const loginData = useAppStore((s) => s.loginData);
  const loginDataStatus = useAppStore((s) => s.loginDataStatus);

  useEffect(() => {
    // Restore the logged-in PSI's POs, sessions and screen from IndexedDB (doc 03 §4.3).
    store.getState().hydrate().catch(console.error);
    // Cached copy at once, refreshed in the background (doc 05 §6 warm start).
    void store.getState().loadLoginData(masterData);
  }, [store, masterData]);

  if (status === 'loading') return <main className="app-screen" />;
  if (auth) return <HomeScreen auth={auth} />;
  if (loginData) return <LoginScreen data={loginData} />;
  return (
    <StartScreen
      failed={loginDataStatus === 'failed'}
      onRetry={() => void store.getState().loadLoginData(masterData)}
    />
  );
}
