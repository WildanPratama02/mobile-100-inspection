/**
 * The screens' data sources on the API (T2.7): `GET /master-data`, `POST /auth/login` and `/auth/refresh`,
 * `GET /pos`, `GET /system/status` (doc 04 §2–3). The device key and the PSI's token come from the app store, which
 * holds what IndexedDB holds. A PO search whose token has expired renews it once and asks again (doc 04 §5).
 */
import type { LoginResponse, MasterData, Po } from '@m100/shared';
import {
  ApiError,
  isMasterData,
  LoginRejectedError,
  OfflineError,
  type AuthApi,
  type DataSources,
} from '../data/sources';
import type { Auth } from '../db/schema';
import type { AppStore } from '../state/store';
import { apiFetch, type ApiRequest, type Fetch } from './client';

function toAuth(response: LoginResponse): Auth {
  return {
    username: response.user.username,
    level: response.user.level,
    factory: response.factory,
    cell: response.cell,
    token: response.token,
    tokenExpiresAt: response.expiresAt,
  };
}

/** The API answered `2xx` with a body this app version cannot read. */
function unreadable(what: string): OfflineError {
  return new OfflineError(new Error(`Unreadable answer from ${what}`));
}

export function createApiSources(store: AppStore, fetchImpl?: Fetch): DataSources {
  const call = (request: Omit<ApiRequest, 'deviceKey'>) =>
    apiFetch({ ...request, deviceKey: store.getState().deviceKey }, fetchImpl);

  const auth: AuthApi = {
    login: async (request) => {
      try {
        const { body } = await call({ method: 'POST', path: '/auth/login', body: request });
        return toAuth(body as LoginResponse);
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.code === 'USER_NOT_FOUND' || error.code === 'CELL_NOT_FOUND')
        ) {
          throw new LoginRejectedError(error.code, error.detail);
        }
        throw error;
      }
    },
    refresh: async (token) => {
      const { body } = await call({ method: 'POST', path: '/auth/refresh', token });
      const { token: next, expiresAt } = body as LoginResponse;
      return { token: next, tokenExpiresAt: expiresAt };
    },
  };

  async function searchOnce(q: string, limit: number, token: string | null): Promise<Po[]> {
    const query = new URLSearchParams({ q, limit: String(limit) });
    const { body } = await call({ path: `/pos?${query.toString()}`, token });
    const items = (body as { items?: unknown } | undefined)?.items;
    if (!Array.isArray(items)) throw unreadable('GET /pos');
    return items as Po[];
  }

  return {
    masterData: {
      get: async (etag) => {
        const { status, headers, body } = await call({ path: '/master-data', etag });
        if (status === 304) return 'unchanged';
        if (!isMasterData(body)) throw unreadable('GET /master-data');
        return { document: body satisfies MasterData, etag: headers.get('ETag') };
      },
    },
    auth,
    pos: {
      search: async (q, limit) => {
        const token = store.getState().auth?.token ?? null;
        try {
          return await searchOnce(q, limit, token);
        } catch (error) {
          if (!(error instanceof ApiError && error.code === 'TOKEN_EXPIRED')) throw error;
          const renewed = await store.getState().renewToken(auth, { force: true });
          return searchOnce(q, limit, renewed);
        }
      },
    },
    system: {
      check: async () => {
        await call({ path: '/system/status' });
      },
    },
  };
}
