import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigate, parseRoute, routePath, setNavigationGuard, type Route } from './router';

afterEach(() => {
  setNavigationGuard(null);
  window.history.replaceState(null, '', '/');
});

describe('parseRoute / routePath', () => {
  const routes: [string, Route][] = [
    ['/admin/', { name: 'submissions' }],
    ['/admin', { name: 'submissions' }],
    ['/admin/submissions', { name: 'submissions' }],
    [
      '/admin/submissions/0b8e5a4c-1f3e-4c55-9a43-2d6f1d2f9a10',
      {
        name: 'submission',
        id: '0b8e5a4c-1f3e-4c55-9a43-2d6f1d2f9a10',
      },
    ],
    ['/admin/psi-users', { name: 'psi-users' }],
    ['/admin/factories', { name: 'factories' }],
    ['/admin/pos/', { name: 'pos' }],
    ['/admin/defects', { name: 'defects' }],
    ['/admin/admins', { name: 'admins' }],
    ['/admin/audit-log', { name: 'audit-log' }],
    ['/admin/nothing', { name: 'not-found' }],
    ['/setup', { name: 'not-found' }],
  ];

  it.each(routes)('%s', (path, route) => {
    expect(parseRoute(path)).toEqual(route);
  });

  it('round-trips every page', () => {
    for (const [, route] of routes) {
      if (route.name === 'not-found') continue;
      expect(parseRoute(routePath(route))).toEqual(route);
    }
  });
});

describe('navigate', () => {
  it('asks the guard first while a form is unsaved, and goes only when told to', () => {
    window.history.replaceState(null, '', '/admin/pos');
    let proceed: (() => void) | null = null;
    const guard = vi.fn((go: () => void) => {
      proceed = go;
    });
    setNavigationGuard(guard);

    navigate('/admin/admins');
    expect(guard).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/admin/pos');

    proceed!();
    expect(window.location.pathname).toBe('/admin/admins');
  });

  it('goes at once without a guard', () => {
    navigate('/admin/defects?x=1');
    expect(`${window.location.pathname}${window.location.search}`).toBe('/admin/defects?x=1');
  });
});
