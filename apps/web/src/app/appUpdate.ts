import { useEffect, useSyncExternalStore } from 'react';
import type { RegisterSWOptions } from 'virtual:pwa-register';

/** `registerSW` of `virtual:pwa-register`; injected so tests need no service worker. */
export type RegisterSW = (options?: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>;

let waiting = false;
let apply: (() => Promise<void>) | null = null;
let applying = false;
const listeners = new Set<() => void>();

function setWaiting(value: boolean) {
  waiting = value;
  listeners.forEach((listener) => listener());
}

/**
 * Registers the service worker. A new version waits instead of taking over (doc 03 §4.8); this only notes that
 * one is waiting. `useApplyUpdateWhenIdle` activates it.
 */
export function startAppUpdates(register: RegisterSW): void {
  const update = register({
    onNeedRefresh: () => setWaiting(true),
    onRegisterError: (error: unknown) => console.error(error),
  });
  apply = () => update(true);
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/**
 * Activates a waiting version, which reloads the app, as soon as `idle` (doc 03 §4.8, doc 05 S1): no dialog, and
 * never in the middle of an inspection. A version left waiting also takes over at the next cold start.
 */
export function useApplyUpdateWhenIdle(idle: boolean): void {
  const pending = useSyncExternalStore(subscribe, () => waiting);
  useEffect(() => {
    if (!pending || !idle || !apply || applying) return;
    applying = true;
    apply().catch((error: unknown) => {
      applying = false;
      console.error(error);
    });
  }, [pending, idle]);
}

/** Forgets the registration; tests only. */
export function resetAppUpdatesForTest(): void {
  waiting = false;
  apply = null;
  applying = false;
  listeners.clear();
}
