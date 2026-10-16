import { totals, type AreaMapEntry, type Po } from '@m100/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as repo from '../db/repo';
import { createDb, type Auth, type M100Db } from '../db/schema';
import { createAppStore, DEFAULT_VIEW, type AppStore } from './store';

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
    expect(await repo.listEvents(db, before[PO.po]!.session.id)).toEqual([]);
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
    expect(await store.getState().tap(PO.po, { type: 'DEFECT', entry: TOE })).toBe(false);
    expect(await store.getState().tap(PO.po, { type: 'UNDO' })).toBe(false);
    expect(store.getState().sessions).toBe(before);
    expect(await repo.listEvents(db, before[PO.po]!.session.id)).toEqual([]);
  });

  it('judges each tap against the one before it, also when taps arrive together', async () => {
    const store = await loggedInWithPo();
    const { tap } = store.getState();
    const results = await Promise.all([
      tap(PO.po, { type: 'START', inspection: 'REWORK' }),
      tap(PO.po, { type: 'START', inspection: 'REWORK' }),
      tap(PO.po, { type: 'DEFECT', entry: TOE }),
    ]);
    expect(results).toEqual([true, false, true]);
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
});
