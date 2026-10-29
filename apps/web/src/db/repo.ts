/**
 * Reads and writes of the local database (doc 03 §4.2–4.4). User data is always read by username, so one
 * PSI never sees another's POs, sessions or screen (AC-02.3); POs, sessions and the screen also by the factory
 * and cell of the login (`Scope`, ADR-021).
 */
import { Dexie } from 'dexie';
import type { DefectId, Po, PoPartial, SessionEventPayload } from '@m100/shared';
import type {
  Auth,
  EventRow,
  M100Db,
  MasterDataRow,
  OutboxPhotoRow,
  OutboxRow,
  PhotoRow,
  PoRow,
  Scope,
  SessionRow,
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

// ---- Device key (doc 03 §4.9): per tablet, kept by logout (doc 03 §4.4) ----

export async function getDeviceKey(db: M100Db): Promise<string | null> {
  const row = await db.meta.get('deviceKey');
  return typeof row?.value === 'string' && row.value !== '' ? row.value : null;
}

export async function saveDeviceKey(db: M100Db, key: string): Promise<void> {
  await db.meta.put({ key: 'deviceKey', value: key });
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

const scopeKey = ({ username, factory, cell }: Scope): [string, string, string] => [
  username,
  factory,
  cell,
];

/** The PSI's POs in this factory and cell, newest first (doc 05 §9: an added PO goes to the top; ADR-021). */
export async function listPos(db: M100Db, scope: Scope): Promise<PoRow[]> {
  const rows = await db.poList.where('[username+factory+cell]').equals(scopeKey(scope)).toArray();
  return rows.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

/**
 * Adds a PO with its empty open session in one transaction, so every listed PO has exactly one open
 * session (doc 03 §4.6 step 4 keeps it that way after SUBMIT PO). A PO already listed is refused (AC-03.1).
 */
export async function addPo(
  db: M100Db,
  scope: Scope,
  po: Po,
  partial: PoPartial | null,
  at: string,
): Promise<{ po: PoRow; session: SessionRow }> {
  return db.transaction('rw', db.poList, db.sessions, async () => {
    if (await db.poList.get([...scopeKey(scope), po.po])) throw new PoAlreadyListedError(po.po);
    const { username, factory, cell } = scope;
    const row: PoRow = { ...po, username, factory, cell, partial, addedAt: at };
    await db.poList.add(row);
    const session = await openSessionInTx(db, scope, po.po, at);
    return { po: row, session };
  });
}

/** PO PARTIAL can change at any time; it is read at SUBMIT PO (doc 05 §10, AC-03.7). */
export async function setPartial(
  db: M100Db,
  scope: Scope,
  po: string,
  partial: PoPartial | null,
): Promise<void> {
  const updated = await db.poList.update([...scopeKey(scope), po], { partial });
  if (updated === 0) throw new Error(`PO ${po} is not in the list of ${scope.username}`);
}

/** Removes a PO whose open session has no events and no photos (AC-03.4); otherwise refuses. */
export async function removePo(db: M100Db, scope: Scope, po: string): Promise<void> {
  await db.transaction('rw', [db.poList, db.sessions, db.events, db.photos], async () => {
    const session = await findOpenSession(db, scope, po);
    if (session) {
      const events = await db.events.where('sessionId').equals(session.id).count();
      const photos = await db.photos.where('sessionId').equals(session.id).count();
      if (events > 0 || photos > 0) throw new PoHasDataError(po);
      await db.sessions.delete(session.id);
    }
    await db.poList.delete([...scopeKey(scope), po]);
  });
}

/**
 * Gives the PSI's rows from before ADR-021 (no factory and cell) to the factory and cell of this login, so a
 * session open during the update is not lost. A PO already listed here keeps its own data; the old row stays
 * unscoped then. Returns the POs claimed.
 */
export function claimUnscoped(db: M100Db, scope: Scope): Promise<string[]> {
  const unscoped = (username: string) => [username, '', ''] as const;
  return db.transaction('rw', [db.poList, db.sessions, db.views], async () => {
    const old = await db.poList
      .where('[username+factory+cell]')
      .equals([...unscoped(scope.username)])
      .toArray();
    const claimed: string[] = [];
    for (const row of old) {
      if (await db.poList.get([...scopeKey(scope), row.po])) continue;
      await db.poList.delete([...unscoped(scope.username), row.po]);
      await db.poList.add({ ...row, factory: scope.factory, cell: scope.cell });
      claimed.push(row.po);
    }
    await db.sessions
      .where('[username+factory+cell]')
      .equals([...unscoped(scope.username)])
      .filter((s) => claimed.includes(s.po))
      .modify({ factory: scope.factory, cell: scope.cell });
    const view = await db.views.get([...unscoped(scope.username)]);
    if (view) {
      if (!(await db.views.get(scopeKey(scope)))) {
        await db.views.add({ ...view, factory: scope.factory, cell: scope.cell });
      }
      await db.views.delete([...unscoped(scope.username)]);
    }
    return claimed;
  });
}

// ---- Sessions and events (doc 03 §4.2) ----

function findOpenSession(db: M100Db, scope: Scope, po: string): Promise<SessionRow | undefined> {
  return db.sessions
    .where('[username+factory+cell+po+status]')
    .equals([...scopeKey(scope), po, 'open'])
    .first();
}

async function openSessionInTx(
  db: M100Db,
  scope: Scope,
  po: string,
  at: string,
): Promise<SessionRow> {
  const found = await findOpenSession(db, scope, po);
  if (found) return found;
  const { username, factory, cell } = scope;
  const session: SessionRow = {
    id: crypto.randomUUID(),
    username,
    factory,
    cell,
    po,
    status: 'open',
    createdAt: at,
  };
  await db.sessions.add(session);
  return session;
}

/** The one open session of a PSI's PO in this factory and cell, created when there is none. */
export function openSession(db: M100Db, scope: Scope, po: string, at: string): Promise<SessionRow> {
  return db.transaction('rw', db.sessions, () => openSessionInTx(db, scope, po, at));
}

export async function listOpenSessions(db: M100Db, scope: Scope): Promise<SessionRow[]> {
  return db.sessions
    .where('[username+factory+cell]')
    .equals(scopeKey(scope))
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

// ---- Outbox (doc 03 §4.6) ----

/** A PSI's own submissions, newest first (doc 05 §14, U14: the outbox is per author like sessions). */
export async function listOutbox(db: M100Db, username: string): Promise<OutboxRow[]> {
  const rows = await db.outbox.where('authorUsername').equals(username).toArray();
  return rows.sort((a, b) => b.sealedAt.localeCompare(a.sealedAt));
}

/** The session changed after its submission was built; nothing was sealed. */
export class SessionChangedError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} changed while it was being sealed`);
    this.name = 'SessionChangedError';
  }
}

export interface SealRequest {
  username: string;
  sessionId: string;
  /** `seq` of the last event the submission was built from; 0 for none. */
  lastSeq: number;
  /** The outbox item, `payloadJson` and `payloadSha256` already computed. */
  item: OutboxRow;
  /** The photos the submission names, as they were when it was built. */
  photos: ReadonlyArray<Pick<PhotoRow, 'defectId' | 'sha256'>>;
  at: string;
}

/**
 * KIRIM (doc 03 §4.6): one transaction writes the outbox item, moves the submitted photos to `outboxPhotos`,
 * closes the session and opens a new empty one for the PO. Either all of it happens or none, so a session is
 * never both live and sealed. Refused when the session is not the PSI's open session, or when its events or
 * photos differ from what the submission was built from. Photos the submission leaves out (a defect undone
 * completely) go with the closed session.
 */
export function sealSession(db: M100Db, request: SealRequest): Promise<SessionRow> {
  const { username, sessionId, lastSeq, item, at } = request;
  return db.transaction(
    'rw',
    [db.sessions, db.events, db.photos, db.outbox, db.outboxPhotos],
    async () => {
      await requireOpenSession(db, username, sessionId);
      const last = await eventsOf(db, sessionId).last();
      if ((last?.seq ?? 0) !== lastSeq) throw new SessionChangedError(sessionId);
      const stored = new Map((await listPhotos(db, sessionId)).map((p) => [p.defectId, p]));
      const moved = request.photos.map(({ defectId, sha256 }) => {
        const photo = stored.get(defectId);
        if (photo?.sha256 !== sha256) throw new SessionChangedError(sessionId);
        const { blob, takenAt } = photo;
        return { submissionUuid: item.submissionUuid, defectId, blob, sha256, takenAt };
      });

      await db.outbox.add(item);
      await db.outboxPhotos.bulkAdd(moved);
      await db.photos.where('sessionId').equals(sessionId).delete();
      await db.sessions.update(sessionId, { status: 'closed' });
      const session = await db.sessions.get(sessionId);
      if (!session) throw new SessionNotOpenError(sessionId);
      // The new session belongs to the same factory and cell as the sealed one (ADR-021).
      return openSessionInTx(db, session, session.po, at);
    },
  );
}

export async function putOutboxItem(db: M100Db, item: OutboxRow): Promise<void> {
  await db.outbox.put(item);
}

export async function getOutboxItem(
  db: M100Db,
  submissionUuid: string,
): Promise<OutboxRow | undefined> {
  return db.outbox.get(submissionUuid);
}

/**
 * The items the sender may try now, oldest seal first (doc 03 §4.6): Menunggu whose `nextAttemptAt` has come,
 * or every Menunggu with `force` (app start, connection back).
 */
export async function nextOutboxItems(
  db: M100Db,
  now: string,
  force: boolean,
): Promise<OutboxRow[]> {
  const rows = await db.outbox.where('state').equals('waiting').toArray();
  return rows
    .filter((o) => force || Date.parse(o.nextAttemptAt) <= Date.parse(now))
    .sort((a, b) => a.sealedAt.localeCompare(b.sealedAt));
}

/** Changes an item and returns it as stored; `undefined` when there is no such item. */
export async function updateOutboxItem(
  db: M100Db,
  submissionUuid: string,
  patch: Partial<Omit<OutboxRow, 'submissionUuid'>>,
): Promise<OutboxRow | undefined> {
  return db.transaction('rw', db.outbox, async () => {
    const updated = await db.outbox.update(submissionUuid, patch);
    return updated === 0 ? undefined : db.outbox.get(submissionUuid);
  });
}

export function listOutboxPhotos(db: M100Db, submissionUuid: string): Promise<OutboxPhotoRow[]> {
  return db.outboxPhotos.where('submissionUuid').equals(submissionUuid).toArray();
}

/**
 * An item left Mengirim by a closed or killed app is Menunggu again and is tried at once; the resend carries the
 * same UUID and bytes (doc 04 §5, last row). Returns the items changed.
 */
export function resetSendingOutbox(db: M100Db, now: string): Promise<OutboxRow[]> {
  return db.transaction('rw', db.outbox, async () => {
    const rows = await db.outbox.where('state').equals('sending').toArray();
    const reset = rows.map((o) => ({ ...o, state: 'waiting' as const, nextAttemptAt: now }));
    await db.outbox.bulkPut(reset);
    return reset;
  });
}

/** How long a Terkirim item and its photos stay on the tablet (doc 04 §5, doc 05 §14). */
export const SENT_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/** Removes Terkirim items sent more than 7 days ago, with their photos. Gagal items are never removed (AC-11.4). */
export function purgeSentOutbox(db: M100Db, now: string): Promise<string[]> {
  return db.transaction('rw', db.outbox, db.outboxPhotos, async () => {
    const cutoff = Date.parse(now) - SENT_KEPT_MS;
    const old = (await db.outbox.where('state').equals('sent').toArray()).filter(
      (o) => o.sentAt !== null && Date.parse(o.sentAt) <= cutoff,
    );
    const ids = old.map((o) => o.submissionUuid);
    await db.outboxPhotos.where('submissionUuid').anyOf(ids).delete();
    await db.outbox.bulkDelete(ids);
    return ids;
  });
}

// ---- Screen state (doc 05 §4, §8.4, §11.5) ----

export async function getView(db: M100Db, scope: Scope): Promise<View | null> {
  const row = await db.views.get(scopeKey(scope));
  if (!row) return null;
  return { screen: row.screen, selectedPo: row.selectedPo, defectPath: row.defectPath };
}

export async function saveView(db: M100Db, scope: Scope, view: View): Promise<void> {
  const { username, factory, cell } = scope;
  await db.views.put({ ...view, username, factory, cell });
}

// ---- Storage ----

/** Asks Chrome not to evict the data under storage pressure (doc 03 §4.3, risk R5). */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
