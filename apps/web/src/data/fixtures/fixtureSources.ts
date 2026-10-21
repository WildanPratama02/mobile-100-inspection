/**
 * Master data, login and PO search from local fixtures, for the Vitest screen tests (the app itself uses the API,
 * T2.7). Same rules as the API (doc 02 §3, doc 04 §3.1): the lists go through `loginUsers` / `loginFactories`, a
 * login is checked against them, and PO search matches like `GET /pos` (doc 04 §3.3). The mapping is the bundled
 * one.
 */
import {
  defaultMapping,
  loginFactories,
  loginUsers,
  type Cell,
  type MasterData,
  type Po,
  type UserListRow,
} from '@m100/shared';
import { LoginRejectedError, PO_QUERY_MIN, PoSearchError, type DataSources } from '../sources';
import { DB_CELL, USER_LIST } from './masterSheets';
import { ALL_PO_MASTER } from './pos';

export interface FixtureSheets {
  users: readonly UserListRow[];
  cells: readonly Cell[];
  pos: readonly Po[];
}

/** A `/master-data` document from the fixture sheets and the bundled mapping. */
export function fixtureMasterData({
  users = USER_LIST,
  cells = DB_CELL,
}: Partial<Omit<FixtureSheets, 'pos'>> = {}): MasterData {
  const mapping = defaultMapping();
  return {
    version: 'fixture-1',
    fetchedAt: new Date().toISOString(),
    users: loginUsers(users),
    factories: loginFactories(cells),
    areas: structuredClone([...mapping.areas]),
    families: structuredClone([...mapping.families]),
    defects: structuredClone([...mapping.defects]),
    map: mapping.map.map((entry, i) => ({ ...entry, mapId: `M${String(i + 1)}` })),
  };
}

export function createFixtureSources({
  users = USER_LIST,
  cells = DB_CELL,
  pos = ALL_PO_MASTER,
}: Partial<FixtureSheets> = {}): DataSources {
  const data = fixtureMasterData({ users, cells });
  return {
    pos: {
      search: (q, limit) => {
        const needle = q.trim().toLowerCase();
        if (needle.length < PO_QUERY_MIN) {
          return Promise.reject(new PoSearchError('Ketik minimal 3 karakter'));
        }
        const found = pos.filter((p) =>
          [p.po, p.article, p.model].some((v) => v.toLowerCase().includes(needle)),
        );
        return Promise.resolve(structuredClone(found.slice(0, limit)));
      },
    },
    masterData: {
      get: (etag) =>
        Promise.resolve(
          etag === `"${data.version}"`
            ? 'unchanged'
            : { document: structuredClone(data), etag: `"${data.version}"` },
        ),
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
        // The fixtures issue no token; `POST /auth/login` does (doc 04 §2).
        return Promise.resolve({
          username,
          level,
          factory,
          cell,
          token: null,
          tokenExpiresAt: null,
        });
      },
      refresh: () => Promise.resolve({ token: null, tokenExpiresAt: null }),
    },
    system: {
      check: () => Promise.resolve(),
    },
  };
}
