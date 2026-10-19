import { useEffect } from 'react';

/**
 * Keeps the screen on while `on` (doc 05 G10, U7). The browser drops the lock when the app is hidden, so it is
 * asked for again when the app comes back. Failure is silent.
 */
export function useWakeLock(on: boolean): void {
  useEffect(() => {
    if (!on || !('wakeLock' in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let done = false;

    const request = () => {
      if (document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return;
      navigator.wakeLock
        .request('screen')
        .then((lock) => {
          if (done) void lock.release().catch(() => undefined);
          else sentinel = lock;
        })
        .catch(() => undefined);
    };

    request();
    document.addEventListener('visibilitychange', request);
    return () => {
      done = true;
      document.removeEventListener('visibilitychange', request);
      void sentinel?.release().catch(() => undefined);
    };
  }, [on]);
}
