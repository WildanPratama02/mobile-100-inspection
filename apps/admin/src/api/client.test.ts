import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, onAuthRequired, queryString, request } from './client';

function answer(status: number, body?: unknown, type = 'application/problem+json'): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': type },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request', () => {
  it('sends X-Requested-With only on state changes (doc 04 §2)', async () => {
    const fetch = vi.fn(() => Promise.resolve(answer(204)));
    vi.stubGlobal('fetch', fetch);
    await request('/me');
    await request('/psi-users', { method: 'POST', body: { username: 'A', level: 'PSI lv.1' } });

    const [getUrl, getInit] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const [postUrl, postInit] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(getUrl).toBe('/v1/admin/me');
    expect(getInit.headers).not.toHaveProperty('X-Requested-With');
    expect(getInit.credentials).toBe('same-origin');
    expect(postUrl).toBe('/v1/admin/psi-users');
    expect(postInit.headers).toMatchObject({
      'X-Requested-With': 'm100-admin',
      'Content-Type': 'application/json',
    });
    expect(postInit.body).toBe('{"username":"A","level":"PSI lv.1"}');
  });

  it('sends a FormData body as is, without a JSON content type', async () => {
    const fetch = vi.fn(() => Promise.resolve(answer(200, { ok: true }, 'application/json')));
    vi.stubGlobal('fetch', fetch);
    const form = new FormData();
    await request('/pos/import', { method: 'POST', body: form, query: { dryRun: true } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/v1/admin/pos/import?dryRun=true');
    expect(init.body).toBe(form);
    expect(init.headers).not.toHaveProperty('Content-Type');
  });

  it('turns a problem+json answer into an ApiError with its detail and errors', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        answer(409, {
          type: 'https://m100/errors/conflict',
          title: 'Conflict',
          status: 409,
          code: 'CONFLICT',
          detail: 'Sudah ada.',
          errors: [{ path: 'username', code: 'DUPLICATE', message: 'Nama sudah ada.' }],
        }),
      ),
    );
    const error = await request('/psi-users', { method: 'POST', body: {} }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      detail: 'Sudah ada.',
      errors: [{ path: 'username', code: 'DUPLICATE', message: 'Nama sudah ada.' }],
    });
  });

  it('reports an answer that is not the API (a proxy page) by its status', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('<html>Bad gateway</html>', { status: 502 })),
    );
    await expect(request('/me')).rejects.toMatchObject({ status: 502, code: 'HTTP_502' });
  });

  it('reports no connection as NETWORK', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(request('/me')).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
  });

  it('tells the session about 401 ADMIN_AUTH_REQUIRED, not about a failed login', async () => {
    const ended = vi.fn();
    const stop = onAuthRequired(ended);
    vi.stubGlobal('fetch', () =>
      Promise.resolve(answer(401, { status: 401, code: 'ADMIN_LOGIN_FAILED' })),
    );
    await request('/auth/login', { method: 'POST', body: {} }).catch(() => undefined);
    expect(ended).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', () =>
      Promise.resolve(answer(401, { status: 401, code: 'ADMIN_AUTH_REQUIRED' })),
    );
    await request('/psi-users').catch(() => undefined);
    expect(ended).toHaveBeenCalledTimes(1);
    stop();
  });

  it('resolves 204 with undefined and JSON with the body', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(answer(204)));
    await expect(request('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
    vi.stubGlobal('fetch', () =>
      Promise.resolve(answer(200, { username: 'admin' }, 'application/json')),
    );
    await expect(request('/me')).resolves.toEqual({ username: 'admin' });
  });
});

describe('queryString', () => {
  it('leaves out empty values: an empty filter is no filter (doc 04 §10 A12)', () => {
    expect(queryString({ from: '2026-10-23', to: '', factory: undefined, page: 2 })).toBe(
      '?from=2026-10-23&page=2',
    );
    expect(queryString({})).toBe('');
  });
});
