/**
 * Where the screens get master data, logins and PO search from. Phase 1 implements these with local fixtures;
 * T2.6 swaps in the API (`GET /master-data`, `POST /auth/login`, `GET /pos`) without changing any screen
 * (doc 08 Phase 1).
 */
import type { Factory, LoginRequest, Po, User } from '@m100/shared';
import type { Auth } from '../db/schema';

/** The part of the `/master-data` document the login screen needs (doc 04 §3.2). */
export interface LoginData {
  /** Same value as the ETag. */
  version: string;
  fetchedAt: string;
  /** PSI lv.1 and PSI lv.2 only, A–Z (AC-01.1). */
  users: User[];
  /** `F <number>` factories only (doc 02 §3.2). */
  factories: Factory[];
}

export interface MasterDataSource {
  /** Rejects when the data can't be loaded (offline, server error). */
  getLoginData(): Promise<LoginData>;
}

export interface AuthApi {
  /** Rejects with `LoginRejectedError` for an unknown user or cell (doc 04 §3.1). */
  login(request: LoginRequest): Promise<Auth>;
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

export interface DataSources {
  masterData: MasterDataSource;
  auth: AuthApi;
  pos: PoSource;
}

/** A refused PO search (for example `422` for a query under 3 characters); `detail` is shown as is (doc 04 §6). */
export class PoSearchError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'PoSearchError';
  }
}

/** `422 USER_NOT_FOUND` / `CELL_NOT_FOUND`; `detail` is shown as is (doc 04 §6). */
export class LoginRejectedError extends Error {
  constructor(
    readonly code: 'USER_NOT_FOUND' | 'CELL_NOT_FOUND',
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'LoginRejectedError';
  }
}
