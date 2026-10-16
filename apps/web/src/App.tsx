import { useEffect } from 'react';
import { getAppStore } from './state/store';

export function App() {
  useEffect(() => {
    // Restore the logged-in PSI's POs, sessions and screen from IndexedDB (doc 03 §4.3).
    getAppStore().getState().hydrate().catch(console.error);
  }, []);
  return <main />;
}
