import { useEffect, useRef } from 'react';
import { setNavigationGuard } from '../app/router';

/**
 * While `dirty`, closing the tab warns (browser prompt) and an in-app navigation (back button, a link) asks
 * `ask` first (doc 05 §20.8: unsaved forms warn before navigation).
 */
export function useUnsavedGuard(dirty: boolean, ask: (proceed: () => void) => void): void {
  const askRef = useRef(ask);
  useEffect(() => {
    askRef.current = ask;
  });

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    setNavigationGuard((proceed) => askRef.current(proceed));
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      setNavigationGuard(null);
    };
  }, [dirty]);
}
