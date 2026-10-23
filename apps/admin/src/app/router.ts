/**
 * A small path router under `/admin/` (doc 03 §7.1: Caddy answers every `/admin/*` path with `index.html`).
 * Links are real `<a href>` so they work with the keyboard, middle click and "open in new tab".
 */
import { useSyncExternalStore } from 'react';

export const BASE = '/admin/';

export type Route =
  | { name: 'submissions' }
  | { name: 'submission'; id: string }
  | { name: 'psi-users' }
  | { name: 'factories' }
  | { name: 'pos' }
  | { name: 'defects' }
  | { name: 'admins' }
  | { name: 'audit-log' }
  | { name: 'not-found' };

const PAGES = ['psi-users', 'factories', 'pos', 'defects', 'admins', 'audit-log'] as const;

/** `/admin/pos` → `{ name: 'pos' }`; a path outside the app or unknown → `not-found`. */
export function parseRoute(pathname: string): Route {
  if (pathname === BASE.slice(0, -1) || pathname === BASE) return { name: 'submissions' };
  if (!pathname.startsWith(BASE)) return { name: 'not-found' };
  const rest = pathname.slice(BASE.length).replace(/\/$/, '');
  const detail = /^submissions\/([^/]+)$/.exec(rest);
  if (detail) return { name: 'submission', id: decodeURIComponent(detail[1]!) };
  if (rest === 'submissions') return { name: 'submissions' };
  const page = PAGES.find((p) => p === rest);
  return page ? { name: page } : { name: 'not-found' };
}

/** The path of a route, under `/admin/`. */
export function routePath(route: Route): string {
  switch (route.name) {
    case 'submissions':
    case 'not-found':
      return BASE;
    case 'submission':
      return `${BASE}submissions/${encodeURIComponent(route.id)}`;
    default:
      return `${BASE}${route.name}`;
  }
}

/**
 * A guard set while a form holds unsaved changes (doc 05 §20.8). It gets the navigation to run if the admin
 * chooses to leave anyway.
 */
type Guard = (proceed: () => void) => void;
let guard: Guard | null = null;

export function setNavigationGuard(next: Guard | null): void {
  guard = next;
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let lastHref = typeof window === 'undefined' ? '' : currentHref();

function currentHref(): string {
  return `${window.location.pathname}${window.location.search}`;
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    const target = currentHref();
    if (guard) {
      // Stay until the admin answers; then go where the back/forward button pointed.
      window.history.pushState(null, '', lastHref);
      guard(() => {
        guard = null;
        navigate(target, { replace: true });
      });
      return;
    }
    lastHref = target;
    notify();
  });
}

/** Goes to `href` (a path under `/admin/`, with an optional query). */
export function navigate(href: string, options: { replace?: boolean } = {}): void {
  const go = () => {
    if (options.replace) window.history.replaceState(null, '', href);
    else window.history.pushState(null, '', href);
    lastHref = currentHref();
    window.scrollTo?.(0, 0);
    notify();
  };
  if (guard) {
    guard(() => {
      guard = null;
      go();
    });
    return;
  }
  go();
}

/** Replaces the query of the current page (filters kept in the URL), without a history entry. */
export function replaceQuery(search: string): void {
  const href = `${window.location.pathname}${search}`;
  if (href === currentHref()) return;
  window.history.replaceState(null, '', href);
  lastHref = href;
  notify();
}

export interface Location {
  route: Route;
  query: URLSearchParams;
  href: string;
}

let cached: Location | null = null;

function snapshot(): Location {
  const href = currentHref();
  if (cached?.href !== href) {
    cached = {
      route: parseRoute(window.location.pathname),
      query: new URLSearchParams(window.location.search),
      href,
    };
  }
  return cached;
}

/** The current route and query; re-renders on every navigation. */
export function useLocation(): Location {
  return useSyncExternalStore(subscribe, snapshot);
}
