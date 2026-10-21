import type { LoginResponse, Po } from '@m100/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureMasterData } from '../data/fixtures/fixtureSources';
import { ApiError, LoginRejectedError, OfflineError } from '../data/sources';
import { createDb, type Auth, type M100Db } from '../db/schema';
import { createAppStore, type AppStore } from '../state/store';
import { createApiSources } from './apiSources';
import type { Fetch } from './client';

const PO: Po = {
  po: '0902028839',
  article: 'FX3581',
  model: 'CORERACER',
  destination: 'XX',
  orderQty: 17,
  podd: '2026-01-12',
  crd: null,
};

const AUTH: Auth = {
  username: 'DEWI CONTOH',
  level: 'PSI lv.2',
  factory: 'F 3',
  cell: 'F3-10',
  token: 'token-lama',
  tokenExpiresAt: '2026-11-20T08:00:00.000+07:00',
};

const LOGIN: LoginResponse = {
  token: 'token-baru',
  expiresAt: '2026-11-21T08:00:00.000+07:00',
  user: { username: 'DEWI CONTOH', level: 'PSI lv.2' },
  factory: 'F 3',
  cell: 'F3-10',
};

const problem = (status: number, code: string, detail = 'detail') =>
  new Response(JSON.stringify({ code, detail, retryable: false }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });

let db: M100Db;
let store: AppStore;

beforeEach(async () => {
  db = createDb(`api-${crypto.randomUUID()}`);
  store = createAppStore(db);
  await store.getState().hydrate();
  await store.getState().saveDeviceKey('kunci-uji');
});

afterEach(async () => {
  await db.delete();
});

/** A fetch that gives the answers in order and records what it was asked. */
function server(...answers: Response[]) {
  const fetchImpl = vi.fn<Fetch>(() => {
    const next = answers.shift();
    return next ? Promise.resolve(next) : Promise.reject(new TypeError('Failed to fetch'));
  });
  const request = (i: number) => {
    const [url, init] = fetchImpl.mock.calls[i]!;
    return { url, method: init.method, headers: new Headers(init.headers), body: init.body };
  };
  return { fetchImpl, request };
}

describe('master data (doc 04 §3.2)', () => {
  it('gives the document with its ETag, sending the device key', async () => {
    const doc = fixtureMasterData();
    const { fetchImpl, request } = server(Response.json(doc, { headers: { ETag: '"12"' } }));
    await expect(createApiSources(store, fetchImpl).masterData.get(null)).resolves.toEqual({
      document: doc,
      etag: '"12"',
    });
    expect(request(0).url).toBe('/v1/master-data');
    expect(request(0).headers.get('X-Device-Key')).toBe('kunci-uji');
  });

  it("is 'unchanged' on 304 for the ETag it was asked with", async () => {
    const { fetchImpl, request } = server(new Response(null, { status: 304 }));
    await expect(createApiSources(store, fetchImpl).masterData.get('"12"')).resolves.toBe(
      'unchanged',
    );
    expect(request(0).headers.get('If-None-Match')).toBe('"12"');
  });

  it('refuses an answer that is not a whole document', async () => {
    const { fetchImpl } = server(Response.json({ version: '1', users: [] }));
    await expect(createApiSources(store, fetchImpl).masterData.get(null)).rejects.toBeInstanceOf(
      OfflineError,
    );
  });
});

describe('login (doc 04 §3.1)', () => {
  const request = {
    username: 'DEWI CONTOH',
    level: 'PSI lv.2',
    factory: 'F 3',
    cell: 'F3-10',
  } as const;

  it('posts the choice and keeps the token and its expiry', async () => {
    const { fetchImpl, request: sent } = server(Response.json(LOGIN));
    await expect(createApiSources(store, fetchImpl).auth.login(request)).resolves.toEqual({
      ...request,
      token: 'token-baru',
      tokenExpiresAt: LOGIN.expiresAt,
    });
    expect(sent(0)).toMatchObject({ url: '/v1/auth/login', method: 'POST' });
    expect(JSON.parse(sent(0).body as string)).toEqual(request);
  });

  it('turns USER_NOT_FOUND and CELL_NOT_FOUND into LoginRejectedError', async () => {
    const { fetchImpl } = server(
      problem(422, 'USER_NOT_FOUND', 'Nama tidak ada di daftar PSI.'),
      problem(422, 'CELL_NOT_FOUND', 'Factory/Cell tidak ditemukan.'),
    );
    const { auth } = createApiSources(store, fetchImpl);
    await expect(auth.login(request)).rejects.toEqual(
      new LoginRejectedError('USER_NOT_FOUND', 'Nama tidak ada di daftar PSI.'),
    );
    await expect(auth.login(request)).rejects.toBeInstanceOf(LoginRejectedError);
  });

  it('passes other refusals on as they are', async () => {
    const { fetchImpl } = server(problem(401, 'DEVICE_KEY_INVALID'));
    const error = await createApiSources(store, fetchImpl)
      .auth.login(request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(LoginRejectedError);
  });

  it('refreshes with the token it is given', async () => {
    const { fetchImpl, request: sent } = server(Response.json(LOGIN));
    await expect(createApiSources(store, fetchImpl).auth.refresh('token-lama')).resolves.toEqual({
      token: 'token-baru',
      tokenExpiresAt: LOGIN.expiresAt,
    });
    expect(sent(0)).toMatchObject({ url: '/v1/auth/refresh', method: 'POST' });
    expect(sent(0).headers.get('Authorization')).toBe('Bearer token-lama');
  });
});

describe('PO search (doc 04 §3.3, AC-13.3)', () => {
  beforeEach(async () => {
    await store.getState().login(AUTH);
  });

  it("asks with the PSI's token and gives the items", async () => {
    const { fetchImpl, request } = server(Response.json({ items: [PO] }));
    await expect(createApiSources(store, fetchImpl).pos.search('8839', 20)).resolves.toEqual([PO]);
    expect(request(0).url).toBe('/v1/pos?q=8839&limit=20');
    expect(request(0).headers.get('Authorization')).toBe('Bearer token-lama');
    expect(request(0).headers.get('X-Device-Key')).toBe('kunci-uji');
  });

  it('renews an expired token once and asks again with the new one (doc 04 §5)', async () => {
    const { fetchImpl, request } = server(
      problem(401, 'TOKEN_EXPIRED'),
      Response.json(LOGIN),
      Response.json({ items: [PO] }),
    );
    await expect(createApiSources(store, fetchImpl).pos.search('8839', 20)).resolves.toEqual([PO]);
    expect(request(1).url).toBe('/v1/auth/refresh');
    expect(request(2).headers.get('Authorization')).toBe('Bearer token-baru');
    expect(store.getState().auth?.token).toBe('token-baru');
  });

  it('gives a refused query its detail', async () => {
    const { fetchImpl } = server(problem(422, 'VALIDATION_FAILED', 'Ketik minimal 3 karakter'));
    await expect(createApiSources(store, fetchImpl).pos.search('88', 20)).rejects.toMatchObject({
      detail: 'Ketik minimal 3 karakter',
    });
  });

  it('is offline without a connection', async () => {
    const { fetchImpl } = server();
    await expect(createApiSources(store, fetchImpl).pos.search('8839', 20)).rejects.toBeInstanceOf(
      OfflineError,
    );
  });
});

describe('system status (doc 03 §4.9)', () => {
  it('checks the stored key', async () => {
    const ok = server(Response.json({ submitEnabled: true, checkedAt: 'x', checks: [] }));
    await expect(createApiSources(store, ok.fetchImpl).system.check()).resolves.toBeUndefined();
    expect(ok.request(0).url).toBe('/v1/system/status');
    const refused = server(problem(401, 'DEVICE_KEY_INVALID'));
    await expect(createApiSources(store, refused.fetchImpl).system.check()).rejects.toMatchObject({
      code: 'DEVICE_KEY_INVALID',
    });
  });
});
