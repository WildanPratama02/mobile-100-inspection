import type { Po } from '@m100/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as repo from './repo';
import { createDb, type Auth, type M100Db, type PhotoRow } from './schema';

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
    const s1 = await repo.openSession(db, A.username, '0903359388', AT);
    const s2 = await repo.openSession(db, A.username, 'CX-0902368685', AT);
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
    const s = await repo.openSession(db, A.username, '0903359388', AT);
    const entry = { areaId: 'A01', subAreaId: 'S01', familyId: 'F01', defectId: 'D049' } as const;
    await repo.appendEvent(db, A.username, s.id, { type: 'DEFECT', ...entry }, AT);
    expect(await repo.listEvents(db, A.username, s.id)).toEqual([
      { type: 'DEFECT', ...entry, sessionId: s.id, seq: 1, at: AT, username: A.username },
    ]);
  });

  it('writes only into the PSI’s own open session', async () => {
    const own = await repo.openSession(db, A.username, '0903359388', AT);
    const closed = await repo.openSession(db, A.username, 'CX-0902368685', AT);
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
    const s = await repo.openSession(db, A.username, '0903359388', AT);
    await repo.appendEvent(db, A.username, s.id, { type: 'NO_DEFECT' }, AT);
    expect(await repo.listEvents(db, 'psi.uji.dua', s.id)).toEqual([]);
  });
});

describe('sessions', () => {
  it('keeps one open session per user and PO', async () => {
    const first = await repo.openSession(db, A.username, '0903359388', AT);
    const again = await repo.openSession(db, A.username, '0903359388', LATER);
    const other = await repo.openSession(db, 'psi.uji.dua', '0903359388', AT);
    expect(again).toEqual(first);
    expect(other.id).not.toBe(first.id);
  });

  it('adds a PO together with its empty open session', async () => {
    const { session } = await repo.addPo(db, A.username, po('0903359388'), null, AT);
    expect(await repo.openSession(db, A.username, '0903359388', LATER)).toEqual(session);
  });
});

describe('user scoping (AC-02.3)', () => {
  it('never returns one PSI’s POs, sessions or screen to another', async () => {
    const B = 'psi.uji.dua';
    await repo.addPo(db, A.username, po('0903359388'), { number: 1, qty: 600 }, AT);
    await repo.saveView(db, A.username, {
      screen: 'defect',
      selectedPo: '0903359388',
      defectPath: { areaId: 'A01', subAreaId: null, familyId: null },
    });

    expect(await repo.listPos(db, B)).toEqual([]);
    expect(await repo.listOpenSessions(db, B)).toEqual([]);
    expect(await repo.getView(db, B)).toBeNull();
    expect(await repo.listPos(db, A.username)).toHaveLength(1);
    expect(await repo.listOpenSessions(db, A.username)).toHaveLength(1);
  });

  it('keeps POs, sessions, events and photos when the login is cleared (AC-02.2)', async () => {
    await repo.saveAuth(db, A);
    const { session } = await repo.addPo(db, A.username, po('0903359388'), null, AT);
    await repo.appendEvent(db, A.username, session.id, { type: 'NO_DEFECT' }, AT);
    await repo.putPhoto(db, A.username, photo(session.id, 'aa'));

    await repo.clearAuth(db);

    expect(await repo.getAuth(db)).toBeNull();
    expect(await repo.listPos(db, A.username)).toHaveLength(1);
    expect(await repo.listOpenSessions(db, A.username)).toEqual([session]);
    expect(await repo.listEvents(db, A.username, session.id)).toHaveLength(1);
    expect(await repo.listPhotos(db, session.id)).toHaveLength(1);
  });
});

describe('PO list', () => {
  it('lists the newest PO first and keeps leading zeros and prefixes (AC-03.5)', async () => {
    await repo.addPo(db, A.username, po('0903359388'), null, AT);
    await repo.addPo(db, A.username, po('CX-0902368685'), null, LATER);
    expect((await repo.listPos(db, A.username)).map((p) => p.po)).toEqual([
      'CX-0902368685',
      '0903359388',
    ]);
  });

  it('refuses a PO already in the list (AC-03.1)', async () => {
    await repo.addPo(db, A.username, po('0903359388'), null, AT);
    await expect(repo.addPo(db, A.username, po('0903359388'), null, LATER)).rejects.toThrow(
      repo.PoAlreadyListedError,
    );
    expect(await repo.listOpenSessions(db, A.username)).toHaveLength(1);
  });

  it('changes the partial of a listed PO', async () => {
    await repo.addPo(db, A.username, po('0903359388'), null, AT);
    await repo.setPartial(db, A.username, '0903359388', { number: 2, qty: 300 });
    expect((await repo.listPos(db, A.username))[0]?.partial).toEqual({ number: 2, qty: 300 });
  });

  it('removes a PO without data and refuses one with data (AC-03.4)', async () => {
    await repo.addPo(db, A.username, po('0903359388'), null, AT);
    const { session } = await repo.addPo(db, A.username, po('CX-0902368685'), null, AT);
    await repo.appendEvent(db, A.username, session.id, { type: 'START_BGRADE' }, AT);

    await repo.removePo(db, A.username, '0903359388');
    await expect(repo.removePo(db, A.username, 'CX-0902368685')).rejects.toThrow(
      repo.PoHasDataError,
    );

    expect((await repo.listPos(db, A.username)).map((p) => p.po)).toEqual(['CX-0902368685']);
    expect((await repo.listOpenSessions(db, A.username)).map((s) => s.po)).toEqual([
      'CX-0902368685',
    ]);
  });

  it('refuses to remove a PO whose session has a photo', async () => {
    const { session } = await repo.addPo(db, A.username, po('0903359388'), null, AT);
    await repo.putPhoto(db, A.username, photo(session.id, 'aa'));
    await expect(repo.removePo(db, A.username, '0903359388')).rejects.toThrow(repo.PoHasDataError);
  });
});

describe('photos', () => {
  it('keeps one photo per defect of a session (AC-10.5)', async () => {
    const s = await repo.openSession(db, A.username, '0903359388', AT);
    await repo.putPhoto(db, A.username, photo(s.id, 'first'));
    await repo.putPhoto(db, A.username, photo(s.id, 'second'));
    expect((await repo.listPhotos(db, s.id)).map((p) => p.sha256)).toEqual(['second']);
    expect((await repo.getPhoto(db, s.id, 'D001'))?.sha256).toBe('second');
  });

  it('removes a photo (HAPUS)', async () => {
    const s = await repo.openSession(db, A.username, '0903359388', AT);
    await repo.putPhoto(db, A.username, photo(s.id, 'aa'));
    await repo.deletePhoto(db, A.username, s.id, 'D001');
    expect(await repo.listPhotos(db, s.id)).toEqual([]);
  });

  it('writes and removes photos only in the PSI’s own open session', async () => {
    const own = await repo.openSession(db, A.username, '0903359388', AT);
    const closed = await repo.openSession(db, A.username, 'CX-0902368685', AT);
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

describe('outbox', () => {
  it('lists submissions newest first', async () => {
    const item = {
      po: '0903359388',
      payloadJson: '{}',
      payloadSha256: 'x',
      authorUsername: A.username,
      authorToken: null,
      state: 'waiting' as const,
      attempts: 0,
      nextAttemptAt: AT,
      lastAttemptAt: null,
      problem: null,
    };
    await repo.putOutboxItem(db, { ...item, submissionUuid: 'u1', sealedAt: AT });
    await repo.putOutboxItem(db, { ...item, submissionUuid: 'u2', sealedAt: LATER });
    expect((await repo.listOutbox(db)).map((o) => o.submissionUuid)).toEqual(['u2', 'u1']);
  });
});
