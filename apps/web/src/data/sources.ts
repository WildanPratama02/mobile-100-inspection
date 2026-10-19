/**
 * Where the screens get master data and logins from. Phase 1 implements these with local fixtures; T2.6 swaps
 * in the API (`GET /master-data`, `POST /auth/login`) without changing any screen (doc 08 Phase 1).
 */
import type { Factory, LoginRequest, User } from '@m100/shared';
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

export interface DataSources {
  masterData: MasterDataSource;
  auth: AuthApi;
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
