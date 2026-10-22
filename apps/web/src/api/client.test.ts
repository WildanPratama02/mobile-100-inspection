import { describe, expect, it, vi } from 'vitest';
import { ApiError, OfflineError, SERVER_ERROR } from '../data/sources';
import { apiFetch, retryAfterOf, type Fetch } from './client';

function answering(response: Response) {
  const fetchImpl = vi.fn<Fetch>(() => Promise.resolve(response));
  const sent = () => {
    const [url, init] = fetchImpl.mock.calls[0]!;
    return { url, init, headers: new Headers(init.headers) };
  };
  return { fetchImpl, sent };
}

const problem = (status: number, body: object) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });

describe('apiFetch (doc 04 §1–2, §6)', () => {
  it('sends the device key, the token and the ETag under /v1, never from a cache', async () => {
    const { fetchImpl, sent } = answering(Response.json({ ok: true }));
    const answer = await apiFetch(
      { path: '/pos?q=8839', deviceKey: 'kunci', token: 'jwt', etag: '"7"' },
      fetchImpl,
    );
    expect(answer).toMatchObject({ status: 200, body: { ok: true } });
    const { url, init, headers } = sent();
    expect(url).toBe('/v1/pos?q=8839');
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store', body: undefined });
    expect(headers.get('X-Device-Key')).toBe('kunci');
    expect(headers.get('Authorization')).toBe('Bearer jwt');
    expect(headers.get('If-None-Match')).toBe('"7"');
  });

  it('sends a JSON body and leaves out what it does not have', async () => {
    const { fetchImpl, sent } = answering(Response.json({}));
    await apiFetch(
      { method: 'POST', path: '/auth/login', deviceKey: null, body: { a: 1 } },
      fetchImpl,
    );
    const { init, headers } = sent();
    expect(init.body).toBe('{"a":1}');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.has('X-Device-Key')).toBe(false);
    expect(headers.has('Authorization')).toBe(false);
  });

  it('passes 304 through without a body', async () => {
    const { fetchImpl } = answering(new Response(null, { status: 304 }));
    await expect(
      apiFetch({ path: '/master-data', deviceKey: 'k' }, fetchImpl),
    ).resolves.toMatchObject({
      status: 304,
      body: undefined,
    });
  });

  it('turns problem+json into an ApiError with its code and detail', async () => {
    const { fetchImpl } = answering(
      problem(422, {
        code: 'USER_NOT_FOUND',
        detail: 'Nama tidak ada di daftar PSI.',
        retryable: false,
      }),
    );
    const error = await apiFetch({ path: '/auth/login', deviceKey: 'k' }, fetchImpl).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: 'USER_NOT_FOUND',
      detail: 'Nama tidak ada di daftar PSI.',
    });
  });

  it('shows the server-error text for a problem without detail', async () => {
    const { fetchImpl } = answering(problem(401, { code: 'TOKEN_EXPIRED' }));
    await expect(apiFetch({ path: '/pos', deviceKey: 'k' }, fetchImpl)).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
      detail: SERVER_ERROR,
    });
  });

  it('sends a multipart body as is, leaving its Content-Type to the browser', async () => {
    const { fetchImpl, sent } = answering(Response.json({}, { status: 201 }));
    const form = new FormData();
    form.append('submission', new Blob(['{}'], { type: 'application/json' }));
    await apiFetch(
      { method: 'POST', path: '/submissions', deviceKey: 'k', token: 'jwt', form },
      fetchImpl,
    );
    const { init, headers } = sent();
    expect(init.body).toBe(form);
    expect(headers.has('Content-Type')).toBe(false);
  });

  it('keeps the failed checks of a 422 and the Retry-After of a 429/503 (doc 04 §4.2, §5)', async () => {
    const errors = [{ path: 'po', code: 'PO_NOT_FOUND', message: 'PO tidak ditemukan.' }];
    const refused = await apiFetch(
      { path: '/submissions', deviceKey: 'k' },
      answering(problem(422, { code: 'PO_NOT_FOUND', detail: 'x', errors })).fetchImpl,
    ).catch((e: unknown) => e);
    expect(refused).toMatchObject({ errors, retryAfter: null });

    const limited = await apiFetch(
      { path: '/submissions', deviceKey: 'k' },
      answering(
        new Response(JSON.stringify({ code: 'RATE_LIMITED' }), {
          status: 429,
          headers: { 'Retry-After': '12' },
        }),
      ).fetchImpl,
    ).catch((e: unknown) => e);
    expect(limited).toMatchObject({ code: 'RATE_LIMITED', errors: [], retryAfter: 12 });
  });

  it('reads Retry-After as seconds or as an HTTP date', () => {
    const now = Date.parse('2026-10-16T07:00:00Z');
    expect(retryAfterOf('30', now)).toBe(30);
    expect(retryAfterOf('Fri, 16 Oct 2026 07:01:30 GMT', now)).toBe(90);
    expect(retryAfterOf('Fri, 16 Oct 2026 06:00:00 GMT', now)).toBe(0);
    expect(retryAfterOf('soon', now)).toBeNull();
    expect(retryAfterOf(null, now)).toBeNull();
  });

  it('counts no connection, a timeout and a proxy page without the API as offline', async () => {
    const down = vi.fn<Fetch>(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(apiFetch({ path: '/master-data', deviceKey: 'k' }, down)).rejects.toBeInstanceOf(
      OfflineError,
    );
    const timeout = vi.fn<Fetch>(() =>
      Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
    );
    await expect(
      apiFetch({ path: '/master-data', deviceKey: 'k' }, timeout),
    ).rejects.toBeInstanceOf(OfflineError);
    const { fetchImpl } = answering(new Response('<html>Bad Gateway</html>', { status: 502 }));
    await expect(
      apiFetch({ path: '/master-data', deviceKey: 'k' }, fetchImpl),
    ).rejects.toBeInstanceOf(OfflineError);
  });
});
