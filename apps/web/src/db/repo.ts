/**
 * Reads and writes of the local database (doc 03 §4.2–4.4). User data is always read by username, so one
 * PSI never sees another's POs, sessions or screen (AC-02.3).
 */
import { Dexie } from 'dexie';
import type { DefectId, Po, PoPartial, Session, SessionEventPayload } from '@m100/shared';
import type {
  Auth,
  EventRow,
  M100Db,
  MasterDataRow,
  OutboxRow,
  PhotoRow,
  PoRow,
  View,
} from './schema';

// ---- Login (FR-01, FR-02) ----

export async function getAuth(db: M100Db): Promise<Auth | null> {
  const row = await db.auth.get('current');
  if (!row) return null;
  const { username, level, factory, cell, token, tokenExpiresAt } = row;
  return { username, level, factory, cell, token, tokenExpiresAt };
}

export async function saveAuth(db: M100Db, auth: Auth): Promise<void> {
  await db.auth.put({ ...auth, id: 'current' });
}

/** LOGOUT deletes the login only; POs, sessions and photos stay for the next login (AC-02.2). */
export async function clearAuth(db: M100Db): Promise<void> {
  await db.auth.delete('current');
}

// ---- Master data (doc 03 §4.3: the last good copy is used when a refresh fails) ----

export async function getMasterData(db: M100Db): Promise<MasterDataRow | null> {
  return (await db.masterData.get('current')) ?? null;
}

export async function saveMasterData(db: M100Db, row: Omit<MasterDataRow, 'id'>): Promise<void> {
  await db.masterData.put({ ...row, id: 'current' });
}

// ---- PO list (FR-03) ----

export class PoAlreadyListedError extends Error {
  constructor(po: string) {
    super(`PO ${po} sudah di list`);
    this.name = 'PoAlreadyListedError';
  }
}

export class PoHasDataError extends Error {
  constructor(po: string) {
    super(`PO ${po} has an open session with data`);
    this.name = 'PoHasDataError';
  }
}

/** The PSI's POs, newest first (doc 05 §9: an added PO goes to the top). */
export async function listPos(db: M100Db, username: string): Promise<PoRow[]> {
  const rows = await db.pos.where('username').equals(username).toArray();
  return rows.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

/**
 * Adds a PO with its empty open session in one transaction, so every listed PO has exactly one open
 * session (doc 03 §4.6 step 4 keeps it that way after SUBMIT PO). A PO already listed is refused (AC-03.1).
 */
export async function addPo(
  db: M100Db,
  username: string,
  po: Po,
  partial: PoPartial | null,
  at: string,
): Promise<{ po: PoRow; session: Session }> {
  return db.transaction('rw', db.pos, db.sessions, async () => {
    if (await db.pos.get([username, po.po])) throw new PoAlreadyListedError(po.po);
    const row: PoRow = { ...po, username, partial, addedAt: at };
    await db.pos.add(row);
    const session = await openSessionInTx(db, username, po.po, at);
    return { po: row, session };
  });
}

/** PO PARTIAL can change at any time; it is read at SUBMIT PO (doc 05 §10, AC-03.7). */
export async function setPartial(
  db: M100Db,
  username: string,
  po: string,
  partial: PoPartial | null,
): Promise<void> {
  const updated = await db.pos.update([username, po], { partial });
  if (updated === 0) throw new Error(`PO ${po} is not in the list of ${username}`);
}

/** Removes a PO whose open session has no events and no photos (AC-03.4); otherwise refuses. */
export async function removePo(db: M100Db, username: string, po: string): Promise<void> {
  await db.transaction('rw', [db.pos, db.sessions, db.events, db.photos], async () => {
    const session = await findOpenSession(db, username, po);
    if (session) {
      const events = await db.events.where('sessionId').equals(session.id).count();
      const photos = await db.photos.where('sessionId').equals(session.id).count();
      if (events > 0 || photos > 0) throw new PoHasDataError(po);
      await db.sessions.delete(session.id);
    }
    await db.pos.delete([username, po]);
  });
}

// ---- Sessions and events (doc 03 §4.2) ----

function findOpenSession(db: M100Db, username: string, po: string): Promise<Session | undefined> {
  return db.sessions.where('[username+po+status]').equals([username, po, 'open']).first();
}

async function openSessionInTx(
  db: M100Db,
  username: string,
  po: string,
  at: string,
): Promise<Session> {
  const found = await findOpenSession(db, username, po);
  if (found) return found;
  const session: Session = { id: crypto.randomUUID(), username, po, status: 'open', createdAt: at };
  await db.sessions.add(session);
  return session;
}

/** The one open session of a PSI's PO, created when there is none. */
export function openSession(
  db: M100Db,
  username: string,
  po: string,
  at: string,
): Promise<Session> {
  return db.transaction('rw', db.sessions, () => openSessionInTx(db, username, po, at));
}

export async function listOpenSessions(db: M100Db, username: string): Promise<Session[]> {
  return db.sessions
    .where('username')
    .equals(username)
    .filter((s) => s.status === 'open')
    .toArray();
}

function eventsOf(db: M100Db, sessionId: string) {
  return db.events
    .where('[sessionId+seq]')
    .between([sessionId, Dexie.minKey], [sessionId, Dexie.maxKey]);
}

/** A PSI's events of one session, in tap order. */
export function listEvents(db: M100Db, username: string, sessionId: string): Promise<EventRow[]> {
  return eventsOf(db, sessionId)
    .filter((e) => e.username === username)
    .toArray();
}

export class SessionNotOpenError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} is not an open session of this user`);
    this.name = 'SessionNotOpenError';
  }
}

/** Taps and photos go only into the PSI's own open session: a sealed session never changes (doc 03 §4.6). */
async function requireOpenSession(db: M100Db, username: string, sessionId: string): Promise<void> {
  const session = await db.sessions.get(sessionId);
  if (session?.username !== username || session.status !== 'open') {
    throw new SessionNotOpenError(sessionId);
  }
}

/**
 * One tap = one write of one event, numbered after the last one of its session (doc 03 §4.2). Only into
 * the PSI's own open session: a sealed session never changes again (doc 03 §4.6).
 */
export function appendEvent(
  db: M100Db,
  username: string,
  sessionId: string,
  payload: SessionEventPayload,
  at: string,
): Promise<EventRow> {
  return db.transaction('rw', db.sessions, db.events, async () => {
    await requireOpenSession(db, username, sessionId);
    const last = await eventsOf(db, sessionId).last();
    const event: EventRow = { ...payload, sessionId, seq: (last?.seq ?? 0) + 1, at, username };
    await db.events.add(event);
    return event;
  });
}

// ---- Photos (FR-10, PSI lv.2 only) ----

/**
 * One photo per defect: a new photo replaces the old one (GANTI FOTO, AC-10.5). Only into the PSI's own open
 * session, like a tap.
 */
export function putPhoto(db: M100Db, username: string, photo: PhotoRow): Promise<void> {
  return db.transaction('rw', db.sessions, db.photos, async () => {
    await requireOpenSession(db, username, photo.sessionId);
    await db.photos.put(photo);
  });
}

/** HAPUS in the photo view (doc 05 §12.2). */
export function deletePhoto(
  db: M100Db,
  username: string,
  sessionId: string,
  defectId: DefectId,
): Promise<void> {
  return db.transaction('rw', db.sessions, db.photos, async () => {
    await requireOpenSession(db, username, sessionId);
    await db.photos.delete([sessionId, defectId]);
  });
}

export function getPhoto(
  db: M100Db,
  sessionId: string,
  defectId: DefectId,
): Promise<PhotoRow | undefined> {
  return db.photos.get([sessionId, defectId]);
}

export function listPhotos(db: M100Db, sessionId: string): Promise<PhotoRow[]> {
  return db.photos.where('sessionId').equals(sessionId).toArray();
}

// ---- Outbox (doc 03 §4.6; sealing comes with SUBMIT PO) ----

/** Submissions on this tablet, newest first (doc 05 §14). */
export async function listOutbox(db: M100Db): Promise<OutboxRow[]> {
  const rows = await db.outbox.toArray();
  return rows.sort((a, b) => b.sealedAt.localeCompare(a.sealedAt));
}

export async function putOutboxItem(db: M100Db, item: OutboxRow): Promise<void> {
  await db.outbox.put(item);
}

// ---- Screen state (doc 05 §4, §8.4, §11.5) ----

export async function getView(db: M100Db, username: string): Promise<View | null> {
  const row = await db.view.get(username);
  if (!row) return null;
  return { screen: row.screen, selectedPo: row.selectedPo, defectPath: row.defectPath };
}

export async function saveView(db: M100Db, username: string, view: View): Promise<void> {
  await db.view.put({ ...view, username });
}

// ---- Storage ----

/** Asks Chrome not to evict the data under storage pressure (doc 03 §4.3, risk R5). */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
