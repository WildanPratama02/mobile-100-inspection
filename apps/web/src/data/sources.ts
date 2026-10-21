/**
 * Where the screens get master data, logins and PO search from: the API (`src/api/apiSources.ts`, T2.7). Vitest
 * gives the screens the same rules from local fixtures (`fixtures/fixtureSources.ts`).
 */
import type { LoginRequest, MasterData, Po } from '@m100/shared';
import type { Auth } from '../db/schema';

/** What the login screen and the Defect screen need (doc 04 §3.2). */
export type { MasterData };

/** A whole `/master-data` document: a copy cached before this app version, or a wrong answer, is not one. */
export function isMasterData(value: unknown): value is MasterData {
  if (typeof value !== 'object' || value === null) return false;
  const doc = value as Record<string, unknown>;
  return (
    typeof doc.version === 'string' &&
    typeof doc.fetchedAt === 'string' &&
    ['users', 'factories', 'areas', 'families', 'defects', 'map'].every((key) =>
      Array.isArray(doc[key]),
    )
  );
}

export interface MasterDataSource {
  /**
   * `GET /master-data` with `If-None-Match: etag`; `'unchanged'` for `304`. Rejects when the data can't be loaded
   * (offline, server error).
   */
  get(etag: string | null): Promise<{ document: MasterData; etag: string | null } | 'unchanged'>;
}

export interface AuthApi {
  /** Rejects with `LoginRejectedError` for an unknown user or cell (doc 04 §3.1). */
  login(request: LoginRequest): Promise<Auth>;
  /** `POST /auth/refresh`: a new 30-day token with the same claims (doc 04 §2). */
  refresh(token: string): Promise<Pick<Auth, 'token' | 'tokenExpiresAt'>>;
}

/** Shortest query `GET /pos` accepts, and its result limit (doc 04 §3.3, §7; FR-03.2). */
export const PO_QUERY_MIN = 3;
export const PO_RESULTS_MAX = 20;

export interface PoSource {
  /**
   * POs whose number, article or model contains `q`, ignoring case, at most `limit` (`GET /pos`, doc 04 §3.3).
   * Needs a connection (AC-13.3). Rejects with `PoSearchError` when the API refuses the query.
   */
  search(q: string, limit: number): Promise<Po[]>;
}

export interface SystemSource {
  /** `GET /system/status` with the stored device key: the setup page's check (doc 03 §4.9). */
  check(): Promise<void>;
}

export interface DataSources {
  masterData: MasterDataSource;
  auth: AuthApi;
  pos: PoSource;
  system: SystemSource;
}

/** An answer of the API with its problem+json `code`; `detail` is Indonesian and shown as is (doc 04 §6). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'ApiError';
  }
}

/** No answer: no connection, the server is unreachable, or the request timed out. */
export class OfflineError extends Error {
  constructor(cause?: unknown) {
    super('No connection to the API', { cause });
    this.name = 'OfflineError';
  }
}

/** A refused PO search (for example `422` for a query under 3 characters). */
export class PoSearchError extends ApiError {
  constructor(detail: string, status = 422, code = 'VALIDATION_FAILED') {
    super(status, code, detail);
    this.name = 'PoSearchError';
  }
}

/** `422 USER_NOT_FOUND` / `CELL_NOT_FOUND` (doc 04 §6). */
export class LoginRejectedError extends ApiError {
  constructor(code: 'USER_NOT_FOUND' | 'CELL_NOT_FOUND', detail: string) {
    super(422, code, detail);
    this.name = 'LoginRejectedError';
  }
}

/** Shown for a server error the API gave no `detail` for (doc 05 §15). */
export const SERVER_ERROR = 'Terjadi kesalahan server. Data tetap tersimpan di tablet.';
