/**
 * App state, hydrated from the local database (doc 03 §4.3).
 *
 * The persistence rule: every action writes to IndexedDB first and changes the state only after the write
 * has resolved, so the screen never shows something a reload would lose (NFR-05, AC-06.2). Actions run one
 * at a time, so each tap is judged against the state left by the tap before it. Only the logged-in PSI's
 * data is ever loaded (AC-02.3). Totals, Top 5 and findings are derived with `@m100/shared`, never stored.
 */
import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  applyEvent,
  EMPTY_SESSION,
  endInspection,
  noDefect,
  recordDefect,
  replay,
  startInspection,
  undo,
  type AreaMapEntry,
  type InspectionType,
  type Po,
  type PoPartial,
  type Session,
  type SessionEvent,
  type SessionEventPayload,
  type SessionState,
} from '@m100/shared';
import type { LoginData, MasterDataSource } from '../data/sources';
import * as repo from '../db/repo';
import { createDb, type Auth, type M100Db, type PoRow, type View } from '../db/schema';

/** A tap on Home or the Defect screen (FR-06, FR-07, FR-08). */
export type TapCommand =
  | { type: 'START'; inspection: InspectionType }
  | { type: 'NO_DEFECT' }
  | { type: 'DEFECT'; entry: AreaMapEntry }
  | { type: 'END' }
  | { type: 'UNDO' };

/** The open session of one PO with its stored events and their reduction. */
export interface PoSession {
  session: Session;
  events: readonly SessionEvent[];
  state: SessionState;
}

export interface AppState {
  status: 'loading' | 'ready';
  auth: Auth | null;
  /** The PSI's POs, newest first. */
  pos: readonly PoRow[];
  /** Open sessions by PO number. */
  sessions: Readonly<Record<string, PoSession>>;
  view: View;
  /** Names and factories/cells for the login screen; `null` until loaded or read from the cache. */
  loginData: LoginData | null;
  /** `failed`: nothing could be loaded and nothing is cached (AC-01.4). */
  loginDataStatus: 'idle' | 'loading' | 'ready' | 'failed';

  // Arrow-typed so components can take them out of the state unbound.
  hydrate: () => Promise<void>;
  /** Shows the cached copy at once, then refreshes it from `source` (doc 03 §4.3). Never rejects. */
  loadLoginData: (source: MasterDataSource) => Promise<void>;
  login: (auth: Auth) => Promise<void>;
  logout: () => Promise<void>;
  addPo: (po: Po, partial: PoPartial | null) => Promise<void>;
  setPartial: (po: string, partial: PoPartial | null) => Promise<void>;
  removePo: (po: string) => Promise<void>;
  /** `false` when the tap is not allowed now (nothing is written). */
  tap: (po: string, command: TapCommand) => Promise<boolean>;
  setView: (patch: Partial<View>) => Promise<void>;
}

export type AppStore = StoreApi<AppState>;

export const DEFAULT_VIEW: View = {
  screen: 'home',
  selectedPo: null,
  defectPath: { areaId: null, subAreaId: null, familyId: null },
};

type UserData = Pick<AppState, 'auth' | 'pos' | 'sessions' | 'view'>;

const LOGGED_OUT: UserData = { auth: null, pos: [], sessions: {}, view: DEFAULT_VIEW };

function toPayload(state: SessionState, command: TapCommand): SessionEventPayload | null {
  switch (command.type) {
    case 'START':
      return startInspection(state, command.inspection);
    case 'NO_DEFECT':
      return noDefect(state);
    case 'DEFECT':
      return recordDefect(state, command.entry);
    case 'END':
      return endInspection(state);
    case 'UNDO':
      return undo(state);
  }
}

async function loadUserData(db: M100Db, auth: Auth | null): Promise<UserData> {
  if (!auth) return LOGGED_OUT;
  const { username } = auth;
  const [pos, open, view] = await Promise.all([
    repo.listPos(db, username),
    repo.listOpenSessions(db, username),
    repo.getView(db, username),
  ]);
  const sessions: Record<string, PoSession> = {};
  for (const session of open) {
    const events = await repo.listEvents(db, username, session.id);
    sessions[session.po] = { session, events, state: replay(events) };
  }
  return { auth, pos, sessions, view: view ?? DEFAULT_VIEW };
}

export function createAppStore(db: M100Db, now: () => string = () => new Date().toISOString()) {
  let queue: Promise<unknown> = Promise.resolve();
  /** Runs actions one after another; a failed action does not block the next. */
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action);
    queue = result.catch(() => undefined);
    return result;
  }

  return createStore<AppState>()((set, get) => {
    function requireUser(): string {
      const auth = get().auth;
      if (!auth) throw new Error('Not logged in');
      return auth.username;
    }

    function requireSession(po: string): PoSession {
      const current = get().sessions[po];
      if (!current) throw new Error(`PO ${po} is not in the list`);
      return current;
    }

    return {
      status: 'loading',
      ...LOGGED_OUT,
      loginData: null,
      loginDataStatus: 'idle',

      hydrate: () =>
        serial(async () => {
          const data = await loadUserData(db, await repo.getAuth(db));
          set({ ...data, status: 'ready' });
        }),

      // Outside `serial`: a slow refresh must never hold back a tap queued behind it (NFR-03).
      loadLoginData: async (source) => {
        if (!get().loginData) set({ loginDataStatus: 'loading' });
        try {
          const cached = await repo.getMasterData(db);
          if (cached && !get().loginData) {
            set({ loginData: cached.document as LoginData, loginDataStatus: 'ready' });
          }
        } catch (error) {
          console.error(error);
        }
        try {
          const fresh = await source.getLoginData();
          set({ loginData: fresh, loginDataStatus: 'ready' });
          await repo.saveMasterData(db, {
            etag: fresh.version,
            fetchedAt: fresh.fetchedAt,
            document: fresh,
          });
        } catch (error) {
          console.error(error);
          if (!get().loginData) set({ loginDataStatus: 'failed' });
        }
      },

      login: (auth) =>
        serial(async () => {
          await repo.saveAuth(db, auth);
          set({ ...(await loadUserData(db, auth)), status: 'ready' });
        }),

      logout: () =>
        serial(async () => {
          await repo.clearAuth(db);
          set({ ...LOGGED_OUT, status: 'ready' });
        }),

      addPo: (po, partial) =>
        serial(async () => {
          const username = requireUser();
          const added = await repo.addPo(db, username, po, partial, now());
          set((s) => ({
            pos: [added.po, ...s.pos],
            sessions: {
              ...s.sessions,
              [po.po]: { session: added.session, events: [], state: EMPTY_SESSION },
            },
          }));
        }),

      setPartial: (po, partial) =>
        serial(async () => {
          const username = requireUser();
          await repo.setPartial(db, username, po, partial);
          set((s) => ({ pos: s.pos.map((p) => (p.po === po ? { ...p, partial } : p)) }));
        }),

      removePo: (po) =>
        serial(async () => {
          const username = requireUser();
          await repo.removePo(db, username, po);
          set((s) => {
            const sessions = { ...s.sessions };
            delete sessions[po];
            return { pos: s.pos.filter((p) => p.po !== po), sessions };
          });
        }),

      tap: (po, command) =>
        serial(async () => {
          const username = requireUser();
          const { session, state } = requireSession(po);
          const payload = toPayload(state, command);
          if (!payload) return false;
          const event = await repo.appendEvent(db, username, session.id, payload, now());
          set((s) => {
            const current = s.sessions[po];
            if (!current) return {};
            return {
              sessions: {
                ...s.sessions,
                [po]: {
                  ...current,
                  events: [...current.events, event],
                  state: applyEvent(current.state, event),
                },
              },
            };
          });
          return true;
        }),

      setView: (patch) =>
        serial(async () => {
          const username = requireUser();
          const view = { ...get().view, ...patch };
          await repo.saveView(db, username, view);
          set({ view });
        }),
    };
  });
}

/**
 * POs whose open session holds recorded taps; LOGOUT warns about these (AC-02.2). A PO added but never
 * tapped does not count, the same rule as removing a PO (`repo.removePo`, AC-03.4).
 */
export function unsubmittedCount(state: Pick<AppState, 'sessions'>): number {
  return Object.values(state.sessions).filter((s) => s.events.length > 0).length;
}

let appStore: AppStore | undefined;

/** The app's store on the `m100` database, created on first use. */
export function getAppStore(): AppStore {
  appStore ??= createAppStore(createDb());
  return appStore;
}

/** Lets tests give the screens their own store; the app uses `getAppStore()`. */
export const AppStoreContext = createContext<AppStore | null>(null);

export function useAppStoreApi(): AppStore {
  return useContext(AppStoreContext) ?? getAppStore();
}

export function useAppStore<T>(selector: (state: AppState) => T): T {
  return useStore(useAppStoreApi(), selector);
}
