import type { DefectId, Po } from '@m100/shared';
import { Dexie } from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as repo from './repo';
import {
  createDb,
  type Auth,
  type M100Db,
  type OutboxRow,
  type PhotoRow,
  type Scope,
} from './schema';

const AT = '2026-10-16T01:00:00.000Z';
const LATER = '2026-10-16T02:00:00.000Z';

const A: Auth = {
  username: 'psi.uji.satu',
  level: 'PSI lv.1',
  factory: 'F 1',
  cell: 'C01',
  token: null,
  tokenExpiresAt: null,
};

const DEFAULT_SCREEN = {
  screen: 'home',
  selectedPo: null,
  defectPath: { areaId: null, subAreaId: null, familyId: null },
} as const;

/** Another PSI on the same tablet, same factory and cell. */
const OTHER: Scope = { username: 'psi.uji.dua', factory: A.factory, cell: A.cell };

const po = (number: string): Po => ({
  po: number,
  article: 'ART-001',
  model: 'MODEL UJI',
  destination: 'XX',
  orderQty: 1200,
  podd: '2026-11-01',
  crd: null,
});

const photo = (sessionId: string, sha256: string): PhotoRow => ({
  sessionId,
  defectId: 'D001',
  blob: new Blob([sha256], { type: 'image/jpeg' }),
  sha256,
  takenAt: AT,
});

let db: M100Db;

beforeEach(async () => {
  db = createDb(`test-${crypto.randomUUID()}`);
  await db.open();
});

afterEach(async () => {
  await db.delete();
});

describe('events', () => {
  it('numbers the events of each session 1, 2, 3 on its own', async () => {
    const s1 = await repo.openSession(db, A, '0903359388', AT);
    const s2 = await repo.openSession(db, A, 'CX-0902368685', AT);
    await repo.appendEvent(db, A.username, s1.id, { type: 'START_REWORK' }, AT);
    await repo.appendEvent(db, A.username, s2.id, { type: 'NO_DEFECT' }, AT);
    await repo.appendEvent(db, A.username, s1.id, { type: 'END' }, AT);
    await repo.appendEvent(db, A.username, s1.id, { type: 'NO_DEFECT' }, AT);

    expect((await repo.listEvents(db, A.username, s1.id)).map((e) => [e.seq, e.type])).toEqual([
      [1, 'START_REWORK'],
      [2, 'END'],
      [3, 'NO_DEFECT'],
    ]);
    expect((await repo.listEvents(db, A.username, s2.id)).map((e) => e.seq)).toEqual([1]);
  });

  it('stores a defect event with its full area map entry', async () => {
    const s = await repo.openSession(db, A, '0903359388', AT);
    const entry = { areaId: 'A01', subAreaId: 'S01', familyId: 'F01', defectId: 'D049' } as const;
    await repo.appendEvent(db, A.username, s.id, { type: 'DEFECT', ...entry }, AT);
    expect(await repo.listEvents(db, A.username, s.id)).toEqual([
      { type: 'DEFECT', ...entry, sessionId: s.id, seq: 1, at: AT, username: A.username },
    ]);
  });

  it('writes only into the PSI’s own open session', async () => {
    const own = await repo.openSession(db, A, '0903359388', AT);
    const closed = await repo.openSession(db, A, 'CX-0902368685', AT);
    await db.sessions.update(closed.id, { status: 'closed' });

    await expect(
      repo.appendEvent(db, 'psi.uji.dua', own.id, { type: 'NO_DEFECT' }, AT),
    ).rejects.toThrow(repo.SessionNotOpenError);
    await expect(
      repo.appendEvent(db, A.username, closed.id, { type: 'NO_DEFECT' }, AT),
    ).rejects.toThrow(repo.SessionNotOpenError);
    await expect(
      repo.appendEvent(db, A.username, 'no-such-session', { type: 'NO_DEFECT' }, AT),
    ).rejects.toThrow(repo.SessionNotOpenError);
    expect(await db.events.count()).toBe(0);
  });

  it('never lists another PSI’s events (AC-02.3)', async () => {
    const s = await repo.openSession(db, A, '0903359388', AT);
    await repo.appendEvent(db, A.username, s.id, { type: 'NO_DEFECT' }, AT);
    expect(await repo.listEvents(db, 'psi.uji.dua', s.id)).toEqual([]);
  });
});

describe('sessions', () => {
  it('keeps one open session per user and PO', async () => {
    const first = await repo.openSession(db, A, '0903359388', AT);
    const again = await repo.openSession(db, A, '0903359388', LATER);
    const other = await repo.openSession(db, OTHER, '0903359388', AT);
    expect(again).toEqual(first);
    expect(other.id).not.toBe(first.id);
  });

  it('adds a PO together with its empty open session', async () => {
    const { session } = await repo.addPo(db, A, po('0903359388'), null, AT);
    expect(await repo.openSession(db, A, '0903359388', LATER)).toEqual(session);
  });
});

describe('user scoping (AC-02.3)', () => {
  it('never returns one PSI’s POs, sessions or screen to another', async () => {
    const B = OTHER;
    await repo.addPo(db, A, po('0903359388'), { number: 1, qty: 600 }, AT);
    await repo.saveView(db, A, {
      screen: 'defect',
      selectedPo: '0903359388',
      defectPath: { areaId: 'A01', subAreaId: null, familyId: null },
    });

    expect(await repo.listPos(db, B)).toEqual([]);
    expect(await repo.listOpenSessions(db, B)).toEqual([]);
    expect(await repo.getView(db, B)).toBeNull();
    expect(await repo.listPos(db, A)).toHaveLength(1);
    expect(await repo.listOpenSessions(db, A)).toHaveLength(1);
  });

  it('keeps the data of each factory and cell apart, also for the same PO (ADR-021)', async () => {
    const otherCell: Scope = { ...A, cell: 'C02' };
    const otherFactory: Scope = { ...A, factory: 'F 2' };
    const first = await repo.addPo(db, A, po('0903359388'), { number: 1, qty: 600 }, AT);
    await repo.saveView(db, A, { ...DEFAULT_SCREEN, selectedPo: '0903359388' });

    for (const scope of [otherCell, otherFactory]) {
      expect(await repo.listPos(db, scope)).toEqual([]);
      expect(await repo.listOpenSessions(db, scope)).toEqual([]);
      expect(await repo.getView(db, scope)).toBeNull();
    }
    const second = await repo.addPo(db, otherCell, po('0903359388'), null, LATER);
    expect(second.session.id).not.toBe(first.session.id);
    await repo.setPartial(db, otherCell, '0903359388', { number: 2, qty: 10 });
    expect((await repo.listPos(db, A))[0]?.partial).toEqual({ number: 1, qty: 600 });
    await repo.removePo(db, otherCell, '0903359388');
    expect(await repo.listPos(db, A)).toHaveLength(1);
    expect(await repo.listOpenSessions(db, A)).toEqual([first.session]);
  });

  it('keeps POs, sessions, events and photos when the login is cleared (AC-02.2)', async () => {
    await repo.saveAuth(db, A);
    const { session } = await repo.addPo(db, A, po('0903359388'), null, AT);
    await repo.appendEvent(db, A.username, session.id, { type: 'NO_DEFECT' }, AT);
    await repo.putPhoto(db, A.username, photo(session.id, 'aa'));

    await repo.clearAuth(db);

    expect(await repo.getAuth(db)).toBeNull();
    expect(await repo.listPos(db, A)).toHaveLength(1);
    expect(await repo.listOpenSessions(db, A)).toEqual([session]);
    expect(await repo.listEvents(db, A.username, session.id)).toHaveLength(1);
    expect(await repo.listPhotos(db, session.id)).toHaveLength(1);
  });
});

describe('PO list', () => {
  it('lists the newest PO first and keeps leading zeros and prefixes (AC-03.5)', async () => {
    await repo.addPo(db, A, po('0903359388'), null, AT);
    await repo.addPo(db, A, po('CX-0902368685'), null, LATER);
    expect((await repo.listPos(db, A)).map((p) => p.po)).toEqual(['CX-0902368685', '0903359388']);
  });

  it('refuses a PO already in the list (AC-03.1)', async () => {
    await repo.addPo(db, A, po('0903359388'), null, AT);
    await expect(repo.addPo(db, A, po('0903359388'), null, LATER)).rejects.toThrow(
      repo.PoAlreadyListedError,
    );
    expect(await repo.listOpenSessions(db, A)).toHaveLength(1);
  });

  it('changes the partial of a listed PO', async () => {
    await repo.addPo(db, A, po('0903359388'), null, AT);
    await repo.setPartial(db, A, '0903359388', { number: 2, qty: 300 });
    expect((await repo.listPos(db, A))[0]?.partial).toEqual({ number: 2, qty: 300 });
  });

  it('removes a PO without data and refuses one with data (AC-03.4)', async () => {
    await repo.addPo(db, A, po('0903359388'), null, AT);
    const { session } = await repo.addPo(db, A, po('CX-0902368685'), null, AT);
    await repo.appendEvent(db, A.username, session.id, { type: 'START_BGRADE' }, AT);

    await repo.removePo(db, A, '0903359388');
    await expect(repo.removePo(db, A, 'CX-0902368685')).rejects.toThrow(repo.PoHasDataError);

    expect((await repo.listPos(db, A)).map((p) => p.po)).toEqual(['CX-0902368685']);
    expect((await repo.listOpenSessions(db, A)).map((s) => s.po)).toEqual(['CX-0902368685']);
  });

  it('refuses to remove a PO whose session has a photo', async () => {
    const { session } = await repo.addPo(db, A, po('0903359388'), null, AT);
    await repo.putPhoto(db, A.username, photo(session.id, 'aa'));
    await expect(repo.removePo(db, A, '0903359388')).rejects.toThrow(repo.PoHasDataError);
  });
});

describe('photos', () => {
  it('keeps one photo per defect of a session (AC-10.5)', async () => {
    const s = await repo.openSession(db, A, '0903359388', AT);
    await repo.putPhoto(db, A.username, photo(s.id, 'first'));
    await repo.putPhoto(db, A.username, photo(s.id, 'second'));
    expect((await repo.listPhotos(db, s.id)).map((p) => p.sha256)).toEqual(['second']);
    expect((await repo.getPhoto(db, s.id, 'D001'))?.sha256).toBe('second');
  });

  it('removes a photo (HAPUS)', async () => {
    const s = await repo.openSession(db, A, '0903359388', AT);
    await repo.putPhoto(db, A.username, photo(s.id, 'aa'));
    await repo.deletePhoto(db, A.username, s.id, 'D001');
    expect(await repo.listPhotos(db, s.id)).toEqual([]);
  });

  it('writes and removes photos only in the PSI’s own open session', async () => {
    const own = await repo.openSession(db, A, '0903359388', AT);
    const closed = await repo.openSession(db, A, 'CX-0902368685', AT);
    await repo.putPhoto(db, A.username, photo(closed.id, 'kept'));
    await db.sessions.update(closed.id, { status: 'closed' });

    await expect(repo.putPhoto(db, 'psi.uji.dua', photo(own.id, 'aa'))).rejects.toThrow(
      repo.SessionNotOpenError,
    );
    await expect(repo.putPhoto(db, A.username, photo(closed.id, 'bb'))).rejects.toThrow(
      repo.SessionNotOpenError,
    );
    await expect(repo.deletePhoto(db, A.username, closed.id, 'D001')).rejects.toThrow(
      repo.SessionNotOpenError,
    );
    expect((await db.photos.toArray()).map((p) => p.sha256)).toEqual(['kept']);
  });
});

const outboxItem = (submissionUuid: string, sealedAt = AT): OutboxRow => ({
  submissionUuid,
  po: '0903359388',
  sealedAt,
  payloadJson: '{}',
  payloadSha256: 'x',
  authorUsername: A.username,
  authorToken: null,
  authorTokenExpiresAt: null,
  state: 'waiting',
  attempts: 0,
  nextAttemptAt: sealedAt,
  lastAttemptAt: null,
  problem: null,
  problemErrors: [],
  displayNo: null,
  sentAt: null,
});

describe('outbox', () => {
  it('lists a PSI’s own submissions, newest first (U14)', async () => {
    await repo.putOutboxItem(db, outboxItem('u1', AT));
    await repo.putOutboxItem(db, outboxItem('u2', LATER));
    await repo.putOutboxItem(db, { ...outboxItem('u3', LATER), authorUsername: 'psi.uji.dua' });
    expect((await repo.listOutbox(db, A.username)).map((o) => o.submissionUuid)).toEqual([
      'u2',
      'u1',
    ]);
    expect((await repo.listOutbox(db, 'psi.uji.dua')).map((o) => o.submissionUuid)).toEqual(['u3']);
  });

  it('gives the sender Menunggu items oldest first, after their wait unless forced', async () => {
    await repo.putOutboxItem(db, { ...outboxItem('later', LATER), nextAttemptAt: LATER });
    await repo.putOutboxItem(db, { ...outboxItem('due', AT), nextAttemptAt: AT });
    await repo.putOutboxItem(db, {
      ...outboxItem('other-author', AT),
      authorUsername: 'psi.uji.dua',
    });
    await repo.putOutboxItem(db, { ...outboxItem('failed', AT), state: 'failed' });
    await repo.putOutboxItem(db, { ...outboxItem('sending', AT), state: 'sending' });
    const ids = (rows: OutboxRow[]) => rows.map((o) => o.submissionUuid);
    // Every author's items: the sender sends for all of them (doc 03 §4.4).
    expect(ids(await repo.nextOutboxItems(db, AT, false))).toEqual(['due', 'other-author']);
    expect(ids(await repo.nextOutboxItems(db, AT, true))).toEqual(['due', 'other-author', 'later']);
  });

  it('turns items left Mengirim back into Menunggu, due now (doc 04 §5)', async () => {
    await repo.putOutboxItem(db, { ...outboxItem('u1', AT), state: 'sending', attempts: 2 });
    await repo.putOutboxItem(db, { ...outboxItem('u2', AT), state: 'sent' });
    expect((await repo.resetSendingOutbox(db, LATER)).map((o) => o.submissionUuid)).toEqual(['u1']);
    expect(await repo.getOutboxItem(db, 'u1')).toMatchObject({
      state: 'waiting',
      attempts: 2,
      nextAttemptAt: LATER,
    });
    expect((await repo.getOutboxItem(db, 'u2'))?.state).toBe('sent');
  });

  it('updates an item and returns it as stored', async () => {
    await repo.putOutboxItem(db, outboxItem('u1'));
    expect(await repo.updateOutboxItem(db, 'u1', { state: 'sending', attempts: 1 })).toMatchObject({
      submissionUuid: 'u1',
      state: 'sending',
      attempts: 1,
    });
    expect(await repo.updateOutboxItem(db, 'none', { state: 'sending' })).toBeUndefined();
  });

  it('removes Terkirim items and their photos 7 days after sending, never Gagal ones', async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = '2026-10-23T01:00:00.000Z';
    const ago = (days: number) => new Date(Date.parse(now) - days * day).toISOString();
    await repo.putOutboxItem(db, { ...outboxItem('old'), state: 'sent', sentAt: ago(7) });
    await repo.putOutboxItem(db, { ...outboxItem('new'), state: 'sent', sentAt: ago(6) });
    await repo.putOutboxItem(db, { ...outboxItem('failed', ago(30)), state: 'failed' });
    for (const id of ['old', 'new', 'failed']) {
      await db.outboxPhotos.add({
        submissionUuid: id,
        defectId: 'D001',
        blob: new Blob(['x'], { type: 'image/jpeg' }),
        sha256: 'x',
        takenAt: AT,
      });
    }
    expect(await repo.purgeSentOutbox(db, now)).toEqual(['old']);
    expect((await db.outbox.toArray()).map((o) => o.submissionUuid).sort()).toEqual([
      'failed',
      'new',
    ]);
    expect((await repo.listOutboxPhotos(db, 'old')).length).toBe(0);
    expect((await repo.listOutboxPhotos(db, 'new')).length).toBe(1);
    expect((await repo.listOutboxPhotos(db, 'failed')).length).toBe(1);
  });
});

describe('sealSession (doc 03 §4.6)', () => {
  const PO = '0903359388';
  const defect = (defectId: DefectId) =>
    ({ type: 'DEFECT', areaId: 'A01', subAreaId: 'S01', familyId: 'F01', defectId }) as const;
  const shot = (sessionId: string, defectId: DefectId): PhotoRow => ({
    ...photo(sessionId, `sha-${defectId}`),
    defectId,
  });

  /** An open session with REWORK, D001 and D002 recorded, ended, and a photo of each. */
  async function recorded() {
    const s = await repo.openSession(db, A, PO, AT);
    await repo.appendEvent(db, A.username, s.id, { type: 'START_REWORK' }, AT);
    await repo.appendEvent(db, A.username, s.id, defect('D001'), AT);
    await repo.appendEvent(db, A.username, s.id, defect('D002'), AT);
    await repo.appendEvent(db, A.username, s.id, { type: 'END' }, AT);
    await repo.putPhoto(db, A.username, shot(s.id, 'D001'));
    await repo.putPhoto(db, A.username, shot(s.id, 'D002'));
    return s;
  }

  const request = (sessionId: string, overrides: Partial<repo.SealRequest> = {}) => ({
    username: A.username,
    sessionId,
    lastSeq: 4,
    item: outboxItem('u1'),
    photos: [{ defectId: 'D001' as const, sha256: 'sha-D001' }],
    at: LATER,
    ...overrides,
  });

  /** Everything sealing touches, to compare before and after a refusal. */
  async function snapshot() {
    return {
      sessions: await db.sessions.toArray(),
      events: await db.events.count(),
      photos: (await db.photos.toArray()).map((p) => [p.sessionId, p.defectId, p.sha256]),
      outbox: await db.outbox.toArray(),
      outboxPhotos: await db.outboxPhotos.toArray(),
    };
  }

  it('writes the outbox item, moves the photos, closes the session and opens a new one', async () => {
    const s = await recorded();
    const next = await repo.sealSession(db, request(s.id));

    expect(await db.outbox.toArray()).toEqual([outboxItem('u1')]);
    const moved = await db.outboxPhotos.toArray();
    expect(moved.map((p) => [p.submissionUuid, p.defectId, p.sha256, p.takenAt])).toEqual([
      ['u1', 'D001', 'sha-D001', AT],
    ]);
    expect(moved[0]?.blob).toBeDefined();
    // D002's photo was not submitted; it leaves with the closed session.
    expect(await db.photos.count()).toBe(0);
    expect((await db.sessions.get(s.id))?.status).toBe('closed');
    expect(next).toMatchObject({ username: A.username, po: PO, status: 'open', createdAt: LATER });
    expect(next.id).not.toBe(s.id);
    expect((await repo.listOpenSessions(db, A)).map((o) => o.id)).toEqual([next.id]);
    // The sealed session never changes again.
    await expect(
      repo.appendEvent(db, A.username, s.id, { type: 'NO_DEFECT' }, LATER),
    ).rejects.toThrow(repo.SessionNotOpenError);
  });

  it('refuses when an event was added after the submission was built', async () => {
    const s = await recorded();
    await repo.appendEvent(db, A.username, s.id, { type: 'NO_DEFECT' }, LATER);
    const before = await snapshot();
    await expect(repo.sealSession(db, request(s.id))).rejects.toThrow(repo.SessionChangedError);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses when a submitted photo was replaced or removed meanwhile', async () => {
    const s = await recorded();
    await repo.putPhoto(db, A.username, { ...shot(s.id, 'D001'), sha256: 'newer' });
    const replaced = await snapshot();
    await expect(repo.sealSession(db, request(s.id))).rejects.toThrow(repo.SessionChangedError);
    expect(await snapshot()).toEqual(replaced);

    await repo.deletePhoto(db, A.username, s.id, 'D001');
    const removed = await snapshot();
    await expect(
      repo.sealSession(db, request(s.id, { photos: [{ defectId: 'D001', sha256: 'newer' }] })),
    ).rejects.toThrow(repo.SessionChangedError);
    expect(await snapshot()).toEqual(removed);
  });

  it('refuses a closed session or another PSI’s session', async () => {
    const s = await recorded();
    const before = await snapshot();
    await expect(repo.sealSession(db, request(s.id, { username: 'psi.uji.dua' }))).rejects.toThrow(
      repo.SessionNotOpenError,
    );
    expect(await snapshot()).toEqual(before);

    await repo.sealSession(db, request(s.id));
    const sealed = await snapshot();
    await expect(repo.sealSession(db, request(s.id, { item: outboxItem('u2') }))).rejects.toThrow(
      repo.SessionNotOpenError,
    );
    expect(await snapshot()).toEqual(sealed);
  });

  it('rolls everything back when a later step fails', async () => {
    const s = await recorded();
    // A leftover photo under the same key makes the photo move fail after the outbox item was written.
    await db.outboxPhotos.add({
      submissionUuid: 'u1',
      defectId: 'D001',
      blob: new Blob(['old']),
      sha256: 'old',
      takenAt: AT,
    });
    const before = await snapshot();
    await expect(repo.sealSession(db, request(s.id))).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(await db.outbox.count()).toBe(0);
    expect((await db.sessions.get(s.id))?.status).toBe('open');
  });
});

describe('update to per-cell data (ADR-021)', () => {
  /** A database as the app before ADR-021 left it: version 1, rows without factory and cell. */
  async function versionOne(name: string) {
    const old = new Dexie(name);
    old.version(1).stores({
      meta: 'key',
      masterData: 'id',
      auth: 'id',
      pos: '[username+po], username',
      sessions: 'id, username, [username+po+status]',
      events: '[sessionId+seq], sessionId',
      photos: '[sessionId+defectId], sessionId',
      outbox: 'submissionUuid, state, authorUsername',
      outboxPhotos: '[submissionUuid+defectId], submissionUuid',
      view: 'username',
    });
    await old.open();
    await old.table('pos').bulkAdd([
      { ...po('0903359388'), username: A.username, partial: null, addedAt: AT },
      { ...po('CX-0902368685'), username: OTHER.username, partial: null, addedAt: AT },
    ]);
    await old.table('sessions').bulkAdd([
      { id: 's1', username: A.username, po: '0903359388', status: 'open', createdAt: AT },
      { id: 's0', username: A.username, po: '0903359388', status: 'closed', createdAt: AT },
      { id: 's2', username: OTHER.username, po: 'CX-0902368685', status: 'open', createdAt: AT },
    ]);
    await old.table('events').add({
      sessionId: 's1',
      seq: 1,
      at: AT,
      type: 'START_REWORK',
      username: A.username,
    });
    await old
      .table('view')
      .add({ ...DEFAULT_SCREEN, selectedPo: '0903359388', username: A.username });
    old.close();
  }

  it('keeps every row, unscoped, and the next login claims the PSI’s own', async () => {
    const name = `test-${crypto.randomUUID()}`;
    await versionOne(name);
    const updated = createDb(name);
    try {
      await updated.open();
      expect(updated.verno).toBe(3);
      expect(updated.tables.map((t) => t.name)).not.toContain('pos');
      expect(await updated.poList.count()).toBe(2);
      const rows = await updated.poList.toArray();
      expect(rows.every((p) => p.factory === '' && p.cell === '')).toBe(true);
      expect(await repo.listPos(updated, A)).toEqual([]);

      expect(await repo.claimUnscoped(updated, A)).toEqual(['0903359388']);
      expect((await repo.listPos(updated, A)).map((p) => p.po)).toEqual(['0903359388']);
      expect((await repo.listOpenSessions(updated, A)).map((s) => s.id)).toEqual(['s1']);
      expect(await repo.listEvents(updated, A.username, 's1')).toHaveLength(1);
      expect((await repo.getView(updated, A))?.selectedPo).toBe('0903359388');
      // Another PSI's rows wait for their own login; a second claim finds nothing.
      expect(await repo.claimUnscoped(updated, A)).toEqual([]);
      expect(await repo.listPos(updated, OTHER)).toEqual([]);
      expect(await repo.claimUnscoped(updated, OTHER)).toEqual(['CX-0902368685']);
      expect((await repo.listOpenSessions(updated, OTHER)).map((s) => s.id)).toEqual(['s2']);
    } finally {
      await updated.delete();
    }
  });

  it('leaves an unscoped PO alone when the same PO is already listed in this cell', async () => {
    await repo.addPo(db, A, po('0903359388'), null, LATER);
    const legacy = { ...po('0903359388'), username: A.username, partial: null, addedAt: AT };
    await db.poList.add({ ...legacy, factory: '', cell: '' });
    expect(await repo.claimUnscoped(db, A)).toEqual([]);
    expect(await repo.listPos(db, A)).toHaveLength(1);
    expect(await db.poList.count()).toBe(2);
  });
});
