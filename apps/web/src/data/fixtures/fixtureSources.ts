/**
 * Master data and login from the Phase 1 fixtures. Same rules as the API (doc 02 §3, doc 04 §3.1): the
 * lists go through `loginUsers` / `loginFactories`, and a login is checked against them.
 */
import { loginFactories, loginUsers, type Cell, type UserListRow } from '@m100/shared';
import { LoginRejectedError, type DataSources, type LoginData } from '../sources';
import { DB_CELL, USER_LIST } from './masterSheets';

export interface FixtureSheets {
  users: readonly UserListRow[];
  cells: readonly Cell[];
}

export function createFixtureSources(
  sheets: FixtureSheets = { users: USER_LIST, cells: DB_CELL },
): DataSources {
  const data: LoginData = {
    version: 'fixture-1',
    fetchedAt: new Date().toISOString(),
    users: loginUsers(sheets.users),
    factories: loginFactories(sheets.cells),
  };
  return {
    masterData: {
      getLoginData: () => Promise.resolve(structuredClone(data)),
    },
    auth: {
      login: ({ username, level, factory, cell }) => {
        if (!data.users.some((u) => u.username === username && u.level === level)) {
          return Promise.reject(
            new LoginRejectedError('USER_NOT_FOUND', 'Nama tidak ada di daftar PSI.'),
          );
        }
        if (!data.factories.some((f) => f.factory === factory && f.cells.includes(cell))) {
          return Promise.reject(
            new LoginRejectedError('CELL_NOT_FOUND', 'Factory/Cell tidak ditemukan.'),
          );
        }
        // The fixtures issue no token; `POST /auth/login` does from Phase 2 (doc 04 §2).
        return Promise.resolve({
          username,
          level,
          factory,
          cell,
          token: null,
          tokenExpiresAt: null,
        });
      },
    },
  };
}
