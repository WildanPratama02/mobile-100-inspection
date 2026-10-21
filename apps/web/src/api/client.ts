/**
 * Requests to the API under `/v1` (doc 04 §1–2, §6). The tablet sends its device key on every request and the
 * PSI's token where one is needed. A problem+json answer becomes an `ApiError` with its `code` and `detail`; no
 * answer at all (offline, server unreachable, timeout) becomes an `OfflineError`. The service worker never caches
 * these calls (doc 03 §4.1); offline data lives in IndexedDB.
 */
import { ApiError, OfflineError, SERVER_ERROR } from '../data/sources';

/** Same origin: Caddy proxies `/v1/*` to the API (doc 03 §7.1); `pnpm dev` and `vite preview` do the same. */
export const API_BASE = '/v1';

/** The tablet's request timeout (doc 04 §5: weak Wi-Fi). */
export const REQUEST_TIMEOUT_MS = 60_000;

export interface ApiRequest {
  method?: 'GET' | 'POST';
  /** Below `/v1`, with its query string, e.g. `/pos?q=8839&limit=20`. */
  path: string;
  deviceKey: string | null;
  token?: string | null;
  /** `If-None-Match`, for `GET /master-data` (doc 04 §3.2). */
  etag?: string | null;
  body?: unknown;
  timeoutMs?: number;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  /** The parsed JSON; `undefined` for `304` or an empty body. */
  body: unknown;
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export async function apiFetch(
  request: ApiRequest,
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): Promise<ApiResponse> {
  const { method = 'GET', path, deviceKey, token, etag, body } = request;
  const headers = new Headers({ Accept: 'application/json' });
  if (deviceKey) headers.set('X-Device-Key', deviceKey);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (etag) headers.set('If-None-Match', etag);
  if (body !== undefined) headers.set('Content-Type', 'application/json');

  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // The app decides what to keep (doc 03 §4.1); `If-None-Match` is sent by the app itself.
      cache: 'no-store',
      signal: AbortSignal.timeout(request.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    text = response.status === 304 ? '' : await response.text();
  } catch (error) {
    throw new OfflineError(error);
  }

  const parsed = parseJson(text);
  if (response.ok || response.status === 304) {
    return { status: response.status, headers: response.headers, body: parsed };
  }
  throw problemOf(response.status, parsed);
}

function parseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * A problem+json body as an `ApiError`. Every answer of the API is problem+json (doc 04 §1), so anything else (the
 * proxy's `502` while the API is down) means the API was not reached.
 */
function problemOf(status: number, body: unknown): ApiError | OfflineError {
  if (typeof body === 'object' && body !== null) {
    const { code, detail } = body as { code?: unknown; detail?: unknown };
    if (typeof code === 'string') {
      return new ApiError(status, code, typeof detail === 'string' ? detail : SERVER_ERROR);
    }
  }
  return new OfflineError(new Error(`HTTP ${String(status)} without problem+json`));
}
