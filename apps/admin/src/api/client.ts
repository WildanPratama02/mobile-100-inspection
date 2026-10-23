/**
 * The admin API on the same origin under `/v1/admin` (doc 04 §8). The session is the HttpOnly cookie `m100_admin`
 * the API sets at login; every state-changing request also carries `X-Requested-With: m100-admin` (doc 04 §2).
 */
import type { Problem, ProblemError } from './types';

export const API_BASE = '/v1/admin';

const REQUESTED_WITH = { 'X-Requested-With': 'm100-admin' } as const;

const NETWORK_DETAIL = 'Tidak dapat terhubung ke server. Periksa koneksi lalu coba lagi.';

/** A refused or failed request, with the API's problem when it sent one (doc 04 §6). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly errors: ProblemError[];

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title ?? problem.code);
    this.name = 'ApiError';
    this.status = problem.status;
    this.code = problem.code;
    this.detail = problem.detail ?? problem.title ?? problem.code;
    this.errors = problem.errors ?? [];
  }
}

type Listener = () => void;
const authListeners = new Set<Listener>();

/** Called whenever the API answers `401 ADMIN_AUTH_REQUIRED`: the session has ended (doc 05 §20.2). */
export function onAuthRequired(listener: Listener): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  /** JSON body, or a `FormData` for the imports. */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

/** `?a=1&b=x`, leaving out empty values (an empty filter is no filter, doc 04 §10 A12). */
export function queryString(query: RequestOptions['query']): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

async function problemOf(response: Response): Promise<Problem> {
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('json')) {
    try {
      const body = (await response.json()) as Partial<Problem>;
      if (typeof body.code === 'string') return { ...body, status: response.status } as Problem;
    } catch {
      // Not the API's answer (for example a proxy page); handled below.
    }
  }
  return {
    status: response.status,
    code: `HTTP_${response.status}`,
    detail: `Terjadi kesalahan server (${response.status}). Coba lagi.`,
  };
}

/** Sends one request; resolves with the JSON body (`undefined` for `204`), rejects with an `ApiError`. */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (method !== 'GET') Object.assign(headers, REQUESTED_WITH);
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}${queryString(options.query)}`, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError({ status: 0, code: 'NETWORK', detail: NETWORK_DETAIL });
  }

  if (!response.ok) {
    const problem = await problemOf(response);
    if (problem.status === 401 && problem.code === 'ADMIN_AUTH_REQUIRED') {
      authListeners.forEach((listener) => listener());
    }
    throw new ApiError(problem);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
