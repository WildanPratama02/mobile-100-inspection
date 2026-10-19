import { useEffect, useRef } from 'react';

/**
 * The Android back gesture acts as BACK while the calling screen is shown (doc 05 §2). The screen keeps one
 * history entry of its own on top; a back gesture pops it, which is put back before `onBack` runs.
 */
export function useBackGesture(onBack: () => void): void {
  const handler = useRef(onBack);
  useEffect(() => {
    handler.current = onBack;
  });

  useEffect(() => {
    window.history.pushState({ m100: 'back' }, '');
    const onPop = () => {
      window.history.pushState({ m100: 'back' }, '');
      handler.current();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
}
