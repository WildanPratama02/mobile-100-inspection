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
  buildSubmission,
  checkSubmit,
  EMPTY_SESSION,
  endInspection,
  noDefect,
  recordDefect,
  replay,
  startInspection,
  submissionPhotos,
  takesPhotos,
  top5,
  undo,
  type AreaMapEntry,
  type DefectId,
  type InspectionType,
  type MappingIndex,
  type Po,
  type PoPartial,
  type Session,
  type SessionEvent,
  type SessionEventPayload,
  type SessionState,
  type SubmitBlock,
} from '@m100/shared';
import { sha256Hex } from '../app/sha256';
import type { LoginData, MasterDataSource } from '../data/sources';
import * as repo from '../db/repo';
import {
  createDb,
  type Auth,
  type M100Db,
  type OutboxRow,
  type PhotoRow,
  type PoRow,
  type View,
} from '../db/schema';

/** A tap on Home or the Defect screen (FR-06, FR-07, FR-08). */
export type TapCommand =
  | { type: 'START'; inspection: InspectionType }
  | { type: 'NO_DEFECT' }
  | { type: 'DEFECT'; entry: AreaMapEntry }
  | { type: 'END' }
  | { type: 'UNDO' };

/** A recorded tap: the session before and after it, so the screen can say what the tap did. */
export interface TapResult {
  before: SessionState;
  after: SessionState;
}

/** A photo as the camera step hands it over: a resized JPEG and its SHA-256 (doc 03 §4.5). */
export type Jpeg = Pick<PhotoRow, 'blob' | 'sha256'>;

/** The open session of one PO with its stored events, their reduction and its photos. */
export interface PoSession {
  session: Session;
  events: readonly SessionEvent[];
  state: SessionState;
  /**
   * One photo per defect (AC-10.5), PSI lv.2 only. A photo stays when its defect leaves the Top 5 (AC-10.4)
   * or is undone; Home shows only those of Top 5 rows.
   */
  photos: Readonly<Partial<Record<DefectId, PhotoRow>>>;
}

export interface AppState {
  status: 'loading' | 'ready';
  auth: Auth | null;
  /** The PSI's POs, newest first. */
  pos: readonly PoRow[];
  /** Open sessions by PO number. */
  sessions: Readonly<Record<string, PoSession>>;
  /** The PSI's own sealed submissions, newest first (AC-11.3, doc 05 U14). */
  outbox: readonly OutboxRow[];
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
  /** `null` when the tap is not allowed now (nothing is written). */
  tap: (po: string, command: TapCommand) => Promise<TapResult | null>;
  /** Attaches a photo to a recorded defect, replacing an earlier one (FR-10, AC-10.5). Never for PSI lv.1. */
  savePhoto: (po: string, defectId: DefectId, jpeg: Jpeg) => Promise<void>;
  /** HAPUS in the photo view (doc 05 §12.2). */
  removePhoto: (po: string, defectId: DefectId) => Promise<void>;
  /**
   * KIRIM (FR-11.3, doc 03 §4.6): seals the PO's open session into the outbox and gives the PO a new empty
   * session; the partial stays (doc 05 U10). Rejects with `SubmitBlockedError` when a check of doc 05 §13.1
   * fails, and with `repo.SessionChangedError` when the stored session differs from the state; nothing is
   * written then.
   */
  submitPo: (po: string, mapping: Pick<MappingIndex, 'defect'>) => Promise<OutboxRow>;
  setView: (patch: Partial<View>) => Promise<void>;
}

export type AppStore = StoreApi<AppState>;

/** SUBMIT PO was refused by a check before anything was written (doc 05 §13.1). */
export class SubmitBlockedError extends Error {
  constructor(readonly block: SubmitBlock) {
    super(`Submit blocked: ${block.kind}`);
    this.name = 'SubmitBlockedError';
  }
}

/** The checks of doc 05 §13.1 for a PO's open session, in order; `null` when it can be submitted. */
export function submitBlock(
  level: Auth['level'],
  session: PoSession | undefined,
  mapping: Pick<MappingIndex, 'defect'>,
): SubmitBlock | null {
  const state = session?.state ?? EMPTY_SESSION;
  return checkSubmit({
    state,
    level,
    top: top5(state, mapping),
    photographed: new Set(Object.keys(session?.photos ?? {}) as DefectId[]),
  });
}

/** The photos a KIRIM of this session submits (doc 04 §4.1), for the confirmation's "Foto" count too. */
export function photosToSubmit(level: Auth['level'], session: PoSession): PhotoRow[] {
  const stored = Object.values(session.photos).filter((p): p is PhotoRow => p !== undefined);
  return submissionPhotos(session.state, level, stored);
}

export const DEFAULT_VIEW: View = {
  screen: 'home',
  selectedPo: null,
  defectPath: { areaId: null, subAreaId: null, familyId: null },
};

type UserData = Pick<AppState, 'auth' | 'pos' | 'sessions' | 'outbox' | 'view'>;

const LOGGED_OUT: UserData = {
  auth: null,
  pos: [],
  sessions: {},
  outbox: [],
  view: DEFAULT_VIEW,
};

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
  const [pos, open, outbox, view] = await Promise.all([
    repo.listPos(db, username),
    repo.listOpenSessions(db, username),
    repo.listOutbox(db, username),
    repo.getView(db, username),
  ]);
  const sessions: Record<string, PoSession> = {};
  for (const session of open) {
    const [events, photos] = await Promise.all([
      repo.listEvents(db, username, session.id),
      repo.listPhotos(db, session.id),
    ]);
    sessions[session.po] = {
      session,
      events,
      state: replay(events),
      photos: Object.fromEntries(photos.map((p) => [p.defectId, p])),
    };
  }
  const restored = view ?? DEFAULT_VIEW;
  // A selection always names a listed PO (doc 05 §8.4).
  const selected = pos.some((p) => p.po === restored.selectedPo) ? restored.selectedPo : null;
  return { auth, pos, sessions, outbox, view: { ...restored, selectedPo: selected } };
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
    function requireAuth(): Auth {
      const auth = get().auth;
      if (!auth) throw new Error('Not logged in');
      return auth;
    }

    function requireUser(): string {
      return requireAuth().username;
    }

    function setPhotos(
      po: string,
      change: (photos: PoSession['photos']) => PoSession['photos'],
    ): void {
      set((s) => {
        const current = s.sessions[po];
        if (!current) return {};
        return {
          sessions: { ...s.sessions, [po]: { ...current, photos: change(current.photos) } },
        };
      });
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

      // ADD TO PO LIST also selects the PO (doc 05 §9.2).
      addPo: (po, partial) =>
        serial(async () => {
          const username = requireUser();
          const added = await repo.addPo(db, username, po, partial, now());
          const view = { ...get().view, selectedPo: po.po };
          await repo.saveView(db, username, view);
          set((s) => ({
            pos: [added.po, ...s.pos],
            sessions: {
              ...s.sessions,
              [po.po]: { session: added.session, events: [], state: EMPTY_SESSION, photos: {} },
            },
            view,
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
          let view = get().view;
          if (view.selectedPo === po) {
            view = { ...view, selectedPo: null };
            await repo.saveView(db, username, view);
          }
          set((s) => {
            const sessions = { ...s.sessions };
            delete sessions[po];
            return { pos: s.pos.filter((p) => p.po !== po), sessions, view };
          });
        }),

      tap: (po, command) =>
        serial(async () => {
          const username = requireUser();
          const { session, state } = requireSession(po);
          const payload = toPayload(state, command);
          if (!payload) return null;
          const event = await repo.appendEvent(db, username, session.id, payload, now());
          const after = applyEvent(state, event);
          set((s) => {
            const current = s.sessions[po];
            if (!current) return {};
            return {
              sessions: {
                ...s.sessions,
                [po]: { ...current, events: [...current.events, event], state: after },
              },
            };
          });
          return { before: state, after };
        }),

      savePhoto: (po, defectId, jpeg) =>
        serial(async () => {
          const { username, level } = requireAuth();
          // AC-10.6: PSI lv.1 never stores a photo, whatever the screen offers.
          if (!takesPhotos(level)) throw new Error(`${level} does not take photos`);
          const { session, state } = requireSession(po);
          if (!state.recorded.some((d) => d.defectId === defectId)) {
            throw new Error(`${defectId} is not recorded on PO ${po}`);
          }
          const photo: PhotoRow = { sessionId: session.id, defectId, ...jpeg, takenAt: now() };
          await repo.putPhoto(db, username, photo);
          setPhotos(po, (photos) => ({ ...photos, [defectId]: photo }));
        }),

      removePhoto: (po, defectId) =>
        serial(async () => {
          const username = requireUser();
          const { session } = requireSession(po);
          await repo.deletePhoto(db, username, session.id, defectId);
          setPhotos(po, (photos) => {
            const rest = { ...photos };
            delete rest[defectId];
            return rest;
          });
        }),

      submitPo: (po, mapping) =>
        serial(async () => {
          const auth = requireAuth();
          const current = requireSession(po);
          const listed = get().pos.find((p) => p.po === po);
          if (!listed) throw new Error(`PO ${po} is not in the list`);
          const block = submitBlock(auth.level, current, mapping);
          if (block) throw new SubmitBlockedError(block);

          // The submission is serialised once, here, and that string is what is ever sent (doc 03 §4.6).
          const submissionUuid = crypto.randomUUID();
          const sealedAt = now();
          const photos = photosToSubmit(auth.level, current);
          const payloadJson = JSON.stringify(
            buildSubmission({
              submissionUuid,
              sealedAt,
              appVersion: __APP_VERSION__,
              user: { username: auth.username, level: auth.level },
              cell: { factory: auth.factory, cell: auth.cell },
              po,
              partial: listed.partial,
              state: current.state,
              photos,
            }),
          );
          const item: OutboxRow = {
            submissionUuid,
            po,
            sealedAt,
            payloadJson,
            payloadSha256: await sha256Hex(payloadJson),
            authorUsername: auth.username,
            authorToken: auth.token,
            state: 'waiting',
            attempts: 0,
            nextAttemptAt: sealedAt,
            lastAttemptAt: null,
            problem: null,
          };
          const session = await repo.sealSession(db, {
            username: auth.username,
            sessionId: current.session.id,
            lastSeq: current.events.at(-1)?.seq ?? 0,
            item,
            photos,
            at: sealedAt,
          });
          // Home shows the new empty session at once (AC-04.2). Sending is not part of Phase 1: the item
          // waits in the outbox until the sender of T3.6 exists.
          set((s) => ({
            sessions: {
              ...s.sessions,
              [po]: { session, events: [], state: EMPTY_SESSION, photos: {} },
            },
            outbox: [item, ...s.outbox],
          }));
          return item;
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
 * Whether a PO's open session holds recorded taps. Such a PO can't be removed (`repo.removePo`, AC-03.4) and
 * LOGOUT warns about it (AC-02.2). A photo is only taken of a recorded defect, so it needs no check here.
 */
export function hasOpenData(session: PoSession | undefined): boolean {
  return (session?.events.length ?? 0) > 0;
}

/** POs whose open session holds recorded taps (AC-02.2). */
export function unsubmittedCount(state: Pick<AppState, 'sessions'>): number {
  return Object.values(state.sessions).filter(hasOpenData).length;
}

/** Submissions still on their way, Menunggu + Mengirim (AC-11.3, doc 05 G11, U15); Gagal is not waiting. */
export function waitingCount(state: Pick<AppState, 'outbox'>): number {
  return state.outbox.filter((o) => o.state === 'waiting' || o.state === 'sending').length;
}

/** The selected PO (doc 05 §8.4); its row is the stored object, so it is a stable selector result. */
export function selectedPo(state: Pick<AppState, 'pos' | 'view'>): PoRow | null {
  return state.pos.find((p) => p.po === state.view.selectedPo) ?? null;
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
