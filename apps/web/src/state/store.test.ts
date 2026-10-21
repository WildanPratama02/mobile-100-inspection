import {
  defaultMapping,
  EMPTY_SESSION,
  toWibIso,
  totals,
  type AreaMapEntry,
  type Po,
  type SubmissionRequest,
} from '@m100/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../app/sha256';
import { ApiError, OfflineError, type MasterData, type MasterDataSource } from '../data/sources';
import * as repo from '../db/repo';
import { createDb, type Auth, type M100Db, type OutboxRow } from '../db/schema';
import {
  createAppStore,
  DEFAULT_VIEW,
  hasOpenData,
  needsRenewal,
  selectedPo,
  SubmitBlockedError,
  unsubmittedCount,
  waitingCount,
  type AppStore,
} from './store';

const A: Auth = {
  username: 'psi.uji.satu',
  level: 'PSI lv.2',
  factory: 'F 1',
  cell: 'C01',
  token: null,
  tokenExpiresAt: null,
};
const B: Auth = { ...A, username: 'psi.uji.dua', level: 'PSI lv.1' };

const PO: Po = {
  po: '0903359388',
  article: 'ART-001',
  model: 'MODEL UJI',
  destination: 'XX',
  orderQty: 1200,
  podd: '2026-11-01',
  crd: null,
};

const TOE: AreaMapEntry = { areaId: 'A01', subAreaId: 'S01', familyId: 'F01', defectId: 'D001' };
const HEEL: AreaMapEntry = { areaId: 'A02', subAreaId: 'S05', familyId: 'F02', defectId: 'D049' };

let name: string;
let db: M100Db;
let clock: number;
let reopened: M100Db[] = [];
const now = () => new Date(Date.UTC(2026, 9, 16, 1, 0, clock++)).toISOString();

/** A second connection to the same database, as after closing and reopening the app. */
async function reopen(): Promise<AppStore> {
  const connection = createDb(name);
  reopened.push(connection);
  const store = createAppStore(connection, now);
  await store.getState().hydrate();
  return store;
}

beforeEach(async () => {
  name = `test-${crypto.randomUUID()}`;
  db = createDb(name);
  clock = 0;
  await db.open();
});

afterEach(async () => {
  reopened.forEach((connection) => connection.close());
  reopened = [];
  await db.delete();
});

async function loggedInWithPo(): Promise<AppStore> {
  const store = createAppStore(db, now);
  await store.getState().hydrate();
  await store.getState().login(A);
  await store.getState().addPo(PO, { number: 1, qty: 600 });
  return store;
}

describe('hydrate', () => {
  it('starts logged out on an empty tablet', async () => {
    const store = createAppStore(db, now);
    expect(store.getState().status).toBe('loading');
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({
      status: 'ready',
      auth: null,
      pos: [],
      sessions: {},
      view: DEFAULT_VIEW,
    });
  });
});

describe('persistence rule (NFR-05)', () => {
  it('leaves the state unchanged when the write fails', async () => {
    const store = await loggedInWithPo();
    const before = store.getState().sessions;
    vi.spyOn(db.events, 'add').mockRejectedValueOnce(new Error('disk full'));

    await expect(
      store.getState().tap(PO.po, { type: 'START', inspection: 'REWORK' }),
    ).rejects.toThrow('disk full');

    expect(store.getState().sessions).toBe(before);
    expect(await repo.listEvents(db, A.username, before[PO.po]!.session.id)).toEqual([]);
  });

  it('shows a tap only once it is in IndexedDB', async () => {
    const store = await loggedInWithPo();
    const sessionId = store.getState().sessions[PO.po]!.session.id;
    const other = createDb(name);
    await other.open();
    // Read the database from another connection the moment the state changes.
    const seenAtChange: Promise<number>[] = [];
    const unsubscribe = store.subscribe(() => {
      seenAtChange.push(other.events.where('sessionId').equals(sessionId).count());
    });

    await store.getState().tap(PO.po, { type: 'START', inspection: 'B-GRADE' });
    await store.getState().tap(PO.po, { type: 'DEFECT', entry: TOE });
    unsubscribe();

    const counts = await Promise.all(seenAtChange);
    other.close();
    // At the k-th change the k-th event is already stored (a later one may be too, as reads queue).
    expect(counts).toHaveLength(2);
    counts.forEach((count, k) => expect(count).toBeGreaterThanOrEqual(k + 1));
  });

  it('writes nothing for a tap that is not allowed', async () => {
    const store = await loggedInWithPo();
    const before = store.getState().sessions;
    expect(await store.getState().tap(PO.po, { type: 'DEFECT', entry: TOE })).toBeNull();
    expect(await store.getState().tap(PO.po, { type: 'UNDO' })).toBeNull();
    expect(store.getState().sessions).toBe(before);
    expect(await repo.listEvents(db, A.username, before[PO.po]!.session.id)).toEqual([]);
  });

  it('judges each tap against the one before it, also when taps arrive together', async () => {
    const store = await loggedInWithPo();
    const { tap } = store.getState();
    const results = await Promise.all([
      tap(PO.po, { type: 'START', inspection: 'REWORK' }),
      tap(PO.po, { type: 'START', inspection: 'REWORK' }),
      tap(PO.po, { type: 'DEFECT', entry: TOE }),
    ]);
    expect(results.map((r) => r !== null)).toEqual([true, false, true]);
    // Each result is judged against the state the tap before it left.
    expect(results[2]?.before.active?.type).toBe('REWORK');
    expect(results[2]?.after.active?.defects).toHaveLength(1);
    const { events, state } = store.getState().sessions[PO.po]!;
    expect(events.map((e) => e.type)).toEqual(['START_REWORK', 'DEFECT']);
    expect(state.counts.rework).toBe(1);
  });
});

describe('reload mid-inspection (AC-06.2)', () => {
  it('restores an active REWORK with its defects and the screen', async () => {
    const store = await loggedInWithPo();
    const { tap, setView } = store.getState();
    await tap(PO.po, { type: 'START', inspection: 'REWORK' });
    await tap(PO.po, { type: 'DEFECT', entry: TOE });
    await tap(PO.po, { type: 'DEFECT', entry: HEEL });
    await setView({
      screen: 'defect',
      selectedPo: PO.po,
      defectPath: { areaId: 'A02', subAreaId: 'S05', familyId: null },
    });

    const reloaded = await reopen();
    const before = store.getState();
    const after = reloaded.getState();

    expect(after.auth).toEqual(A);
    expect(after.pos).toEqual(before.pos);
    expect(after.view).toEqual(before.view);
    expect(after.sessions).toEqual(before.sessions);
    const session = after.sessions[PO.po]!.state;
    expect(session.active?.type).toBe('REWORK');
    expect(session.active?.defects).toHaveLength(2);
    expect(session.undo).toBe('DEFECT');
    expect(totals(session)).toMatchObject({ qtyInspection: 1, qtyDefect: 2, qtyBGrade: 0 });
  });

  it('restores a log with an ended inspection, UNDO and an active B-GRADE', async () => {
    const store = await loggedInWithPo();
    const { tap } = store.getState();
    await tap(PO.po, { type: 'START', inspection: 'REWORK' });
    await tap(PO.po, { type: 'DEFECT', entry: TOE });
    await tap(PO.po, { type: 'END' });
    await tap(PO.po, { type: 'NO_DEFECT' });
    await tap(PO.po, { type: 'UNDO' });
    await tap(PO.po, { type: 'START', inspection: 'B-GRADE' });
    await tap(PO.po, { type: 'DEFECT', entry: HEEL });
    await tap(PO.po, { type: 'DEFECT', entry: TOE });
    await tap(PO.po, { type: 'UNDO' });

    const after = (await reopen()).getState().sessions[PO.po]!.state;

    expect(after).toEqual(store.getState().sessions[PO.po]!.state);
    expect(after.active?.type).toBe('B-GRADE');
    expect(totals(after)).toMatchObject({
      qtyInspection: 2,
      qtyAGrade: 0,
      qtyDefect: 2,
      qtyBGrade: 1,
    });
  });

  it('restores PO PARTIAL changes', async () => {
    const store = await loggedInWithPo();
    await store.getState().setPartial(PO.po, { number: 2, qty: 300 });
    expect((await reopen()).getState().pos[0]?.partial).toEqual({ number: 2, qty: 300 });
  });
});

describe('shared tablet (AC-02.2, AC-02.3)', () => {
  it('shows each PSI only their own POs, sessions and screen', async () => {
    const store = await loggedInWithPo();
    await store.getState().tap(PO.po, { type: 'START', inspection: 'REWORK' });
    await store.getState().setView({ selectedPo: PO.po });
    const aSessions = store.getState().sessions;

    await store.getState().logout();
    expect(store.getState()).toMatchObject({ auth: null, pos: [], sessions: {} });

    await store.getState().login(B);
    expect(store.getState()).toMatchObject({ auth: B, pos: [], sessions: {}, view: DEFAULT_VIEW });
    expect((await reopen()).getState().sessions).toEqual({});

    await store.getState().logout();
    await store.getState().login(A);
    expect(store.getState().sessions).toEqual(aSessions);
    expect(store.getState().view.selectedPo).toBe(PO.po);
  });

  it('refuses changes when nobody is logged in', async () => {
    const store = createAppStore(db, now);
    await store.getState().hydrate();
    await expect(store.getState().addPo(PO, null)).rejects.toThrow('Not logged in');
    expect(await db.pos.count()).toBe(0);
  });
});

describe('PO list', () => {
  it('adds a PO at the top with an empty session and removes it again', async () => {
    const store = await loggedInWithPo();
    const second = { ...PO, po: 'CX-0902368685' };
    await store.getState().addPo(second, null);
    expect(store.getState().pos.map((p) => p.po)).toEqual(['CX-0902368685', '0903359388']);
    expect(store.getState().sessions[second.po]?.events).toEqual([]);

    await store.getState().removePo(second.po);
    expect(store.getState().pos.map((p) => p.po)).toEqual(['0903359388']);
    expect(store.getState().sessions[second.po]).toBeUndefined();
    expect((await reopen()).getState().pos.map((p) => p.po)).toEqual(['0903359388']);
  });

  it('selects an added PO and remembers it across a reload (doc 05 §8.4, §9.2)', async () => {
    const store = await loggedInWithPo();
    expect(selectedPo(store.getState())?.po).toBe(PO.po);
    await store.getState().addPo({ ...PO, po: 'CX-0902368685' }, null);
    expect(selectedPo(store.getState())?.po).toBe('CX-0902368685');
    expect(selectedPo((await reopen()).getState())?.po).toBe('CX-0902368685');
  });

  it('clears the selection when the selected PO is removed, and keeps it otherwise', async () => {
    const store = await loggedInWithPo();
    await store.getState().addPo({ ...PO, po: 'CX-0902368685' }, null);
    await store.getState().removePo(PO.po);
    expect(store.getState().view.selectedPo).toBe('CX-0902368685');
    await store.getState().removePo('CX-0902368685');
    expect(store.getState().view.selectedPo).toBeNull();
    expect((await reopen()).getState().view.selectedPo).toBeNull();
  });

  it('drops a stored selection whose PO is no longer listed', async () => {
    const store = await loggedInWithPo();
    await store.getState().setView({ selectedPo: '0000000000' });
    expect((await reopen()).getState().view.selectedPo).toBeNull();
  });
});

describe('hasOpenData (AC-03.4)', () => {
  it('is true once the open session holds a tap, also one that was undone', async () => {
    const store = await loggedInWithPo();
    expect(hasOpenData(store.getState().sessions[PO.po])).toBe(false);
    await store.getState().tap(PO.po, { type: 'START', inspection: 'REWORK' });
    await store.getState().tap(PO.po, { type: 'UNDO' });
    expect(hasOpenData(store.getState().sessions[PO.po])).toBe(true);
  });
});

describe('master data (AC-01.4, AC-13.1, AC-13.2, doc 03 §4.7)', () => {
  const DATA: MasterData = {
    version: 'v1',
    fetchedAt: '2026-10-16T08:00:00+07:00',
    users: [{ username: 'ANDI CONTOH', level: 'PSI lv.1' }],
    factories: [{ factory: 'F 1', cells: ['F1-01'] }],
    areas: [],
    families: [],
    defects: [],
    map: [],
  };
  const etagOf = (data: MasterData) => `"${data.version}"`;
  /** A source that answers `304` when asked with the ETag of `data`, and records what it was asked with. */
  function serving(data: MasterData) {
    const asked: Array<string | null> = [];
    const source: MasterDataSource = {
      get: (etag) => {
        asked.push(etag);
        return Promise.resolve(
          etag === etagOf(data) ? 'unchanged' : { document: data, etag: etagOf(data) },
        );
      },
    };
    return { source, asked };
  }
  const down = (code?: string): MasterDataSource => ({
    get: () =>
      Promise.reject(
        code ? new ApiError(401, code, 'Tablet belum terdaftar.') : new OfflineError(),
      ),
  });

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('loads from the source and keeps a copy with its ETag on the tablet', async () => {
    const store = createAppStore(db, now);
    expect(await store.getState().loadMasterData(serving(DATA).source)).toBe(true);
    expect(store.getState()).toMatchObject({ masterData: DATA, masterDataStatus: 'ready' });
    expect(store.getState().masterDataCheckedAt).not.toBeNull();
    expect(await repo.getMasterData(db)).toMatchObject({ etag: '"v1"', document: DATA });
  });

  it('asks with the stored ETag and keeps the copy on 304, noting when it was checked', async () => {
    const { source, asked } = serving(DATA);
    await createAppStore(db, now).getState().loadMasterData(source);
    const before = (await repo.getMasterData(db))?.fetchedAt;
    const store = await reopen();
    expect(await store.getState().loadMasterData(source)).toBe(true);
    expect(asked).toEqual([null, '"v1"']);
    expect(store.getState().masterData).toEqual(DATA);
    const after = await repo.getMasterData(db);
    expect(after?.fetchedAt).not.toBe(before);
    expect(store.getState().masterDataCheckedAt).toBe(after?.fetchedAt);
  });

  it('uses the stored copy when the source fails', async () => {
    await createAppStore(db, now).getState().loadMasterData(serving(DATA).source);
    const store = await reopen();
    expect(await store.getState().loadMasterData(down())).toBe(false);
    expect(store.getState()).toMatchObject({ masterData: DATA, masterDataStatus: 'ready' });
  });

  it('fails with nothing cached, names an API refusal, and a retry recovers', async () => {
    const store = createAppStore(db, now);
    await store.getState().loadMasterData(down());
    expect(store.getState()).toMatchObject({
      masterData: null,
      masterDataStatus: 'failed',
      masterDataProblem: null,
    });
    await store.getState().loadMasterData(down('DEVICE_KEY_INVALID'));
    expect(store.getState().masterDataProblem).toBe('DEVICE_KEY_INVALID');
    await store.getState().loadMasterData(serving(DATA).source);
    expect(store.getState()).toMatchObject({
      masterData: DATA,
      masterDataStatus: 'ready',
      masterDataProblem: null,
    });
  });

  it('replaces the stored copy with a fresh one', async () => {
    await createAppStore(db, now).getState().loadMasterData(serving(DATA).source);
    const fresh = { ...DATA, version: 'v2', users: [] };
    const store = await reopen();
    await store.getState().loadMasterData(serving(fresh).source);
    expect(store.getState().masterData).toEqual(fresh);
    expect((await repo.getMasterData(db))?.etag).toBe('"v2"');
  });

  it('ignores a stored copy that is not a whole document', async () => {
    await repo.saveMasterData(db, {
      etag: 'fixture-1',
      fetchedAt: '2026-10-16T08:00:00+07:00',
      document: { version: 'fixture-1', users: [], factories: [] },
    });
    const { source, asked } = serving(DATA);
    const store = createAppStore(db, now);
    await store.getState().loadMasterData(source);
    expect(asked).toEqual([null]);
    expect(store.getState().masterData).toEqual(DATA);
  });
});

describe('device key (doc 03 §4.9)', () => {
  it('is stored, read back at the next start and kept by logout (doc 03 §4.4)', async () => {
    const store = createAppStore(db, now);
    await store.getState().hydrate();
    expect(store.getState().deviceKey).toBeNull();
    await store.getState().saveDeviceKey('kunci-uji');
    await store.getState().login(A);
    await store.getState().logout();
    expect(store.getState().deviceKey).toBe('kunci-uji');
    expect((await reopen()).getState().deviceKey).toBe('kunci-uji');
  });
});

describe('renewToken (doc 04 §2)', () => {
  // `now` is about 2026-10-16T01:00Z.
  const WITH_TOKEN: Auth = {
    ...A,
    token: 'token-lama',
    tokenExpiresAt: '2026-11-10T01:00:00.000Z',
  };
  const EXPIRING: Auth = { ...WITH_TOKEN, tokenExpiresAt: '2026-10-20T01:00:00.000Z' };
  const RENEWED = { token: 'token-baru', tokenExpiresAt: '2026-11-15T01:00:00.000Z' };

  async function loggedIn(auth: Auth): Promise<AppStore> {
    const store = createAppStore(db, now);
    await store.getState().hydrate();
    await store.getState().login(auth);
    return store;
  }

  it('leaves a token with 7 days or more alone', async () => {
    const refresh = vi.fn(() => Promise.resolve(RENEWED));
    const store = await loggedIn(WITH_TOKEN);
    expect(needsRenewal(WITH_TOKEN, now())).toBe(false);
    await expect(store.getState().renewToken({ refresh })).resolves.toBe('token-lama');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('renews a token with fewer than 7 days left and stores it', async () => {
    const refresh = vi.fn(() => Promise.resolve(RENEWED));
    const store = await loggedIn(EXPIRING);
    await expect(store.getState().renewToken({ refresh })).resolves.toBe('token-baru');
    expect(refresh).toHaveBeenCalledWith('token-lama');
    expect(store.getState().auth).toEqual({ ...EXPIRING, ...RENEWED });
    expect((await reopen()).getState().auth).toEqual({ ...EXPIRING, ...RENEWED });
  });

  it('renews any token with force', async () => {
    const refresh = vi.fn(() => Promise.resolve(RENEWED));
    const store = await loggedIn(WITH_TOKEN);
    await expect(store.getState().renewToken({ refresh }, { force: true })).resolves.toBe(
      'token-baru',
    );
  });

  it('does nothing without a token', async () => {
    const refresh = vi.fn(() => Promise.resolve(RENEWED));
    const store = await loggedIn(A);
    await expect(store.getState().renewToken({ refresh }, { force: true })).resolves.toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('logs the PSI out on TOKEN_INVALID and keeps their POs (AC-02.2)', async () => {
    const store = await loggedIn(EXPIRING);
    await store.getState().addPo(PO, null);
    const refresh = () =>
      Promise.reject(new ApiError(401, 'TOKEN_INVALID', 'Sesi login tidak valid.'));
    await expect(store.getState().renewToken({ refresh })).rejects.toBeInstanceOf(ApiError);
    expect(store.getState().auth).toBeNull();
    expect(await repo.listPos(db, A.username)).toHaveLength(1);
  });

  it('keeps the login when the API cannot be reached', async () => {
    const store = await loggedIn(EXPIRING);
    const refresh = () => Promise.reject(new OfflineError());
    await expect(store.getState().renewToken({ refresh })).rejects.toBeInstanceOf(OfflineError);
    expect(store.getState().auth).toEqual(EXPIRING);
  });

  it('does not hold back a tap while the API answers (NFR-03)', async () => {
    const store = await loggedIn(EXPIRING);
    await store.getState().addPo(PO, null);
    let answer: (value: typeof RENEWED) => void = () => undefined;
    const pending = store.getState().renewToken({
      refresh: () => new Promise((resolve) => (answer = resolve)),
    });
    await store.getState().tap(PO.po, { type: 'START', inspection: 'REWORK' });
    expect(store.getState().sessions[PO.po]?.state.active).not.toBeNull();
    answer(RENEWED);
    await expect(pending).resolves.toBe('token-baru');
  });

  it('keeps the login of another PSI who logged in meanwhile', async () => {
    const store = await loggedIn(EXPIRING);
    let answer: (value: typeof RENEWED) => void = () => undefined;
    const pending = store.getState().renewToken({
      refresh: () => new Promise((resolve) => (answer = resolve)),
    });
    await store.getState().logout();
    await store.getState().login({ ...B, token: 'token-b', tokenExpiresAt: null });
    answer(RENEWED);
    await expect(pending).resolves.toBe('token-b');
    expect(store.getState().auth?.username).toBe(B.username);
    expect((await repo.getAuth(db))?.token).toBe('token-b');
  });
});

describe('unsubmittedCount (AC-02.2)', () => {
  it('counts only POs whose open session has taps', async () => {
    const store = await loggedInWithPo();
    await store.getState().addPo({ ...PO, po: 'CX-0902368685' }, null);
    expect(unsubmittedCount(store.getState())).toBe(0);
    await store.getState().tap(PO.po, { type: 'START', inspection: 'REWORK' });
    expect(unsubmittedCount(store.getState())).toBe(1);
  });
});

describe('photos (FR-10)', () => {
  const jpeg = (sha256: string) => ({ blob: new Blob([sha256], { type: 'image/jpeg' }), sha256 });

  async function withDefect(): Promise<AppStore> {
    const store = await loggedInWithPo();
    await store.getState().tap(PO.po, { type: 'START', inspection: 'REWORK' });
    await store.getState().tap(PO.po, { type: 'DEFECT', entry: TOE });
    return store;
  }

  it('stores a photo with the session and restores it after a reload (AC-10.2)', async () => {
    const store = await withDefect();
    await store.getState().savePhoto(PO.po, 'D001', jpeg('aa'));

    const sessionId = store.getState().sessions[PO.po]!.session.id;
    expect(store.getState().sessions[PO.po]!.photos.D001).toMatchObject({
      sessionId,
      defectId: 'D001',
      sha256: 'aa',
    });
    const restored = (await reopen()).getState().sessions[PO.po]!.photos;
    expect(Object.keys(restored)).toEqual(['D001']);
    expect(restored.D001?.sha256).toBe('aa');
  });

  it('keeps one photo per defect: GANTI FOTO replaces it (AC-10.5)', async () => {
    const store = await withDefect();
    await store.getState().savePhoto(PO.po, 'D001', jpeg('first'));
    await store.getState().savePhoto(PO.po, 'D001', jpeg('second'));
    const sessionId = store.getState().sessions[PO.po]!.session.id;
    expect((await repo.listPhotos(db, sessionId)).map((p) => p.sha256)).toEqual(['second']);
    expect(store.getState().sessions[PO.po]!.photos.D001?.sha256).toBe('second');
  });

  it('removes a photo (HAPUS)', async () => {
    const store = await withDefect();
    await store.getState().savePhoto(PO.po, 'D001', jpeg('aa'));
    await store.getState().removePhoto(PO.po, 'D001');
    const sessionId = store.getState().sessions[PO.po]!.session.id;
    expect(store.getState().sessions[PO.po]!.photos).toEqual({});
    expect(await repo.listPhotos(db, sessionId)).toEqual([]);
  });

  it('keeps a photo when its defect is undone or outranked (AC-10.4)', async () => {
    const store = await withDefect();
    await store.getState().savePhoto(PO.po, 'D001', jpeg('aa'));
    await store.getState().tap(PO.po, { type: 'DEFECT', entry: HEEL });
    await store.getState().tap(PO.po, { type: 'UNDO' });
    await store.getState().tap(PO.po, { type: 'UNDO' });
    expect(store.getState().sessions[PO.po]!.photos.D001?.sha256).toBe('aa');
  });

  it('never stores a photo for PSI lv.1 (AC-10.6)', async () => {
    const store = createAppStore(db, now);
    await store.getState().hydrate();
    await store.getState().login(B);
    await store.getState().addPo(PO, null);
    await store.getState().tap(PO.po, { type: 'START', inspection: 'REWORK' });
    await store.getState().tap(PO.po, { type: 'DEFECT', entry: TOE });

    await expect(store.getState().savePhoto(PO.po, 'D001', jpeg('aa'))).rejects.toThrow(
      'PSI lv.1 does not take photos',
    );
    expect(await db.photos.count()).toBe(0);
    expect(store.getState().sessions[PO.po]!.photos).toEqual({});
  });

  it('refuses a photo of a defect that is not recorded', async () => {
    const store = await withDefect();
    await expect(store.getState().savePhoto(PO.po, 'D049', jpeg('aa'))).rejects.toThrow(
      'D049 is not recorded',
    );
    expect(await db.photos.count()).toBe(0);
  });

  it('leaves the state unchanged when the write fails (NFR-05)', async () => {
    const store = await withDefect();
    const before = store.getState().sessions;
    vi.spyOn(db.photos, 'put').mockRejectedValueOnce(new Error('QuotaExceededError'));
    await expect(store.getState().savePhoto(PO.po, 'D001', jpeg('aa'))).rejects.toThrow(
      'QuotaExceededError',
    );
    expect(store.getState().sessions).toBe(before);
  });
});

describe('submitPo (FR-11, doc 03 §4.6)', () => {
  const mapping = defaultMapping();
  const jpeg = (sha256: string) => ({ blob: new Blob([sha256], { type: 'image/jpeg' }), sha256 });

  /** PSI lv.2 with REWORK: D001 ×2, then B-GRADE: D049, then NO DEFECT; D001 photographed. */
  async function readyToSubmit(): Promise<AppStore> {
    const store = await loggedInWithPo();
    const { tap, savePhoto } = store.getState();
    await tap(PO.po, { type: 'START', inspection: 'REWORK' });
    await tap(PO.po, { type: 'DEFECT', entry: TOE });
    await tap(PO.po, { type: 'DEFECT', entry: TOE });
    await tap(PO.po, { type: 'END' });
    await tap(PO.po, { type: 'START', inspection: 'B-GRADE' });
    await tap(PO.po, { type: 'DEFECT', entry: HEEL });
    await tap(PO.po, { type: 'END' });
    await tap(PO.po, { type: 'NO_DEFECT' });
    await savePhoto(PO.po, 'D001', jpeg('sha-toe'));
    await savePhoto(PO.po, 'D049', jpeg('sha-heel'));
    return store;
  }

  /** Everything sealing touches, to compare before and after a refusal. */
  async function snapshot() {
    return {
      sessions: await db.sessions.toArray(),
      events: await db.events.count(),
      photos: (await db.photos.toArray()).map((p) => [p.sessionId, p.defectId, p.sha256]),
      outbox: await db.outbox.toArray(),
      outboxPhotos: await db.outboxPhotos.count(),
    };
  }

  it('seals the session into the outbox and starts an empty one, partial kept (AC-04.2, U10)', async () => {
    const store = await readyToSubmit();
    const sealed = store.getState().sessions[PO.po]!.session;

    const item = await store.getState().submitPo(PO.po, mapping);

    expect(item).toMatchObject({
      po: PO.po,
      authorUsername: A.username,
      authorToken: null,
      state: 'waiting',
      attempts: 0,
      lastAttemptAt: null,
      problem: null,
    });
    expect(item.nextAttemptAt).toBe(item.sealedAt);
    const after = store.getState();
    expect(after.outbox).toEqual([item]);
    expect(waitingCount(after)).toBe(1);
    const next = after.sessions[PO.po]!;
    expect(next.session.id).not.toBe(sealed.id);
    expect(next).toMatchObject({ events: [], state: EMPTY_SESSION, photos: {} });
    expect(totals(next.state)).toMatchObject({ qtyInspection: 0, qtyDefect: 0 });
    expect(after.pos[0]?.partial).toEqual({ number: 1, qty: 600 });
    expect((await db.sessions.get(sealed.id))?.status).toBe('closed');
    expect(
      (await db.outboxPhotos.toArray()).map((p) => [p.submissionUuid, p.defectId]).sort(),
    ).toEqual([
      [item.submissionUuid, 'D001'],
      [item.submissionUuid, 'D049'],
    ]);
    expect(await db.photos.count()).toBe(0);
  });

  it('stores the submission string once, with its matching SHA-256 (doc 04 §4.3)', async () => {
    const store = await readyToSubmit();
    const item = await store.getState().submitPo(PO.po, mapping);

    const stored = await db.outbox.get(item.submissionUuid);
    expect(stored?.payloadJson).toBe(item.payloadJson);
    expect(stored?.payloadSha256).toBe(await sha256Hex(item.payloadJson));
    expect(item.payloadSha256).toMatch(/^[0-9a-f]{64}$/);

    const payload = JSON.parse(item.payloadJson) as SubmissionRequest;
    expect(payload).toMatchObject({
      submissionUuid: item.submissionUuid,
      sealedAt: toWibIso(item.sealedAt),
      appVersion: __APP_VERSION__,
      user: { username: A.username, level: 'PSI lv.2' },
      factory: 'F 1',
      cell: 'C01',
      po: PO.po,
      partial: { number: 1, qty: 600 },
      counts: { rework: 1, bGrade: 1, noDefect: 1 },
    });
    expect(payload.findings.map((f) => [f.inspectionType, f.defectId, f.qty])).toEqual([
      ['REWORK', 'D001', 2],
      ['B-GRADE', 'D049', 1],
    ]);
    expect(payload.findings.every((f) => f.firstRecordedAt.endsWith('+07:00'))).toBe(true);
    expect(payload.photos).toEqual([
      { defectId: 'D001', part: 'photo_D001', sha256: 'sha-toe' },
      { defectId: 'D049', part: 'photo_D049', sha256: 'sha-heel' },
    ]);
  });

  it('keeps the outbox and the new session across a reload (AC-11.2)', async () => {
    const store = await readyToSubmit();
    const item = await store.getState().submitPo(PO.po, mapping);
    const reloaded = (await reopen()).getState();
    expect(reloaded.outbox).toEqual([item]);
    expect(reloaded.sessions).toEqual(store.getState().sessions);
  });

  it('refuses by the checks of doc 05 §13.1 and writes nothing', async () => {
    const store = await loggedInWithPo();
    const { tap, submitPo, removePhoto } = store.getState();
    const blocked = async (kind: string) => {
      const before = await snapshot();
      const error = await submitPo(PO.po, mapping).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SubmitBlockedError);
      expect((error as SubmitBlockedError).block.kind).toBe(kind);
      expect(await snapshot()).toEqual(before);
      expect(store.getState().outbox).toEqual([]);
    };

    await blocked('EMPTY');
    await tap(PO.po, { type: 'START', inspection: 'REWORK' });
    await blocked('ACTIVE');
    await tap(PO.po, { type: 'DEFECT', entry: TOE });
    await tap(PO.po, { type: 'END' });
    await blocked('PHOTOS_MISSING');
    await store.getState().savePhoto(PO.po, 'D001', jpeg('aa'));
    await removePhoto(PO.po, 'D001');
    await blocked('PHOTOS_MISSING');
  });

  it('submits PSI lv.1 without photos (AC-10.6)', async () => {
    const store = createAppStore(db, now);
    await store.getState().hydrate();
    await store.getState().login(B);
    await store.getState().addPo(PO, null);
    await store.getState().tap(PO.po, { type: 'START', inspection: 'REWORK' });
    await store.getState().tap(PO.po, { type: 'DEFECT', entry: TOE });
    await store.getState().tap(PO.po, { type: 'END' });

    const item = await store.getState().submitPo(PO.po, mapping);
    const payload = JSON.parse(item.payloadJson) as SubmissionRequest;
    expect(payload.photos).toEqual([]);
    expect(payload.partial).toBeNull();
    expect(payload.user).toEqual({ username: B.username, level: 'PSI lv.1' });
    expect(await db.outboxPhotos.count()).toBe(0);
  });

  it('refuses when the session changed after the submission was built, changing nothing', async () => {
    const store = await readyToSubmit();
    const before = store.getState();
    const sessionId = before.sessions[PO.po]!.session.id;
    // Another tab of the app taps on the same session behind this store's back.
    const realSeal = repo.sealSession;
    vi.spyOn(repo, 'sealSession').mockImplementationOnce(async (database, request) => {
      await repo.appendEvent(database, A.username, sessionId, { type: 'START_REWORK' }, now());
      return realSeal(database, request);
    });
    const stored = await snapshot();

    await expect(store.getState().submitPo(PO.po, mapping)).rejects.toThrow(
      repo.SessionChangedError,
    );

    const after = await snapshot();
    expect(after).toEqual({ ...stored, events: stored.events + 1 });
    expect(store.getState().sessions).toBe(before.sessions);
    expect(store.getState().outbox).toBe(before.outbox);
  });

  it('rolls everything back when sealing fails on the tablet', async () => {
    const store = await readyToSubmit();
    const before = store.getState();
    const stored = await snapshot();
    vi.spyOn(db.outboxPhotos, 'bulkAdd').mockRejectedValueOnce(new Error('QuotaExceededError'));

    await expect(store.getState().submitPo(PO.po, mapping)).rejects.toThrow('QuotaExceededError');

    expect(await snapshot()).toEqual(stored);
    expect(store.getState().sessions).toBe(before.sessions);
    expect(store.getState().outbox).toEqual([]);
  });

  it('shows each PSI only their own submissions (U14)', async () => {
    const store = await readyToSubmit();
    await store.getState().submitPo(PO.po, mapping);
    await store.getState().logout();
    await store.getState().login(B);
    expect(store.getState().outbox).toEqual([]);
    expect(waitingCount(store.getState())).toBe(0);
    await store.getState().logout();
    await store.getState().login(A);
    expect(store.getState().outbox).toHaveLength(1);
  });
});

describe('waitingCount (AC-11.3, U15)', () => {
  it('counts Menunggu and Mengirim, not Gagal or Terkirim', () => {
    const states = ['waiting', 'sending', 'failed', 'sent', 'waiting'] as const;
    const outbox = states.map((state) => ({ state }) as OutboxRow);
    expect(waitingCount({ outbox })).toBe(3);
  });
});
