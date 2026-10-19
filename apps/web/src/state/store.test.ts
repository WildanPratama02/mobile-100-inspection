import { totals, type AreaMapEntry, type Po } from '@m100/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginData, MasterDataSource } from '../data/sources';
import * as repo from '../db/repo';
import { createDb, type Auth, type M100Db } from '../db/schema';
import {
  createAppStore,
  DEFAULT_VIEW,
  hasOpenData,
  selectedPo,
  unsubmittedCount,
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

describe('login data (AC-01.4, doc 03 §4.3)', () => {
  const DATA: LoginData = {
    version: 'v1',
    fetchedAt: '2026-10-16T08:00:00+07:00',
    users: [{ username: 'ANDI CONTOH', level: 'PSI lv.1' }],
    factories: [{ factory: 'F 1', cells: ['F1-01'] }],
  };
  const ok = (data: LoginData): MasterDataSource => ({ getLoginData: () => Promise.resolve(data) });
  const down: MasterDataSource = { getLoginData: () => Promise.reject(new Error('offline')) };

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('loads from the source and keeps a copy on the tablet', async () => {
    const store = createAppStore(db, now);
    await store.getState().loadLoginData(ok(DATA));
    expect(store.getState()).toMatchObject({ loginData: DATA, loginDataStatus: 'ready' });
    expect(await repo.getMasterData(db)).toMatchObject({ etag: 'v1', document: DATA });
  });

  it('uses the stored copy when the source fails', async () => {
    await createAppStore(db, now).getState().loadLoginData(ok(DATA));
    const store = await reopen();
    await store.getState().loadLoginData(down);
    expect(store.getState()).toMatchObject({ loginData: DATA, loginDataStatus: 'ready' });
  });

  it('fails with nothing cached, and a retry recovers', async () => {
    const store = createAppStore(db, now);
    await store.getState().loadLoginData(down);
    expect(store.getState()).toMatchObject({ loginData: null, loginDataStatus: 'failed' });
    await store.getState().loadLoginData(ok(DATA));
    expect(store.getState()).toMatchObject({ loginData: DATA, loginDataStatus: 'ready' });
  });

  it('replaces the stored copy with a fresh one', async () => {
    await createAppStore(db, now).getState().loadLoginData(ok(DATA));
    const fresh = { ...DATA, version: 'v2', users: [] };
    const store = await reopen();
    await store.getState().loadLoginData(ok(fresh));
    expect(store.getState().loginData).toEqual(fresh);
    expect((await repo.getMasterData(db))?.etag).toBe('v2');
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
