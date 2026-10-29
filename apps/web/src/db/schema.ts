/**
 * The tablet's local database (doc 03 §4.2).
 *
 * Everything that must survive a reload lives here and is written before the UI shows its effect (NFR-05,
 * doc 03 §4.3). User data (`poList`, `sessions`, `events`, `views`) carries the username and every query filters
 * by it (AC-02.3, BR-09); POs, sessions and the screen also by factory and cell (`Scope`, ADR-021).
 */
import { Dexie, type Table } from 'dexie';
import type {
  AreaId,
  DefectId,
  Po,
  PoPartial,
  PsiLevel,
  Session,
  SessionEvent,
} from '@m100/shared';

/** Tablet-wide values: `deviceKey`, `installedAt`, `appVersion`, `masterDataVersion`, `masterDataFetchedAt`. */
export interface MetaRow {
  key: string;
  value: unknown;
}

/** The `/master-data` document as received, with its ETag (doc 03 §4.7). */
export interface MasterDataRow {
  id: 'current';
  etag: string | null;
  /** When the API last confirmed this copy current (`200` or `304`); shown in the gear menu (AC-13.4). */
  fetchedAt: string;
  /** Checked with `isMasterData` before use: a copy from an older app version may not be whole. */
  document: unknown;
}

/** The PSI logged in on this tablet. LOGOUT deletes this row only (AC-02.2). */
export interface Auth {
  username: string;
  level: PsiLevel;
  factory: string;
  cell: string;
  /** Issued by `POST /auth/login`; `null` only with the Vitest fixtures. */
  token: string | null;
  tokenExpiresAt: string | null;
}

export interface AuthRow extends Auth {
  id: 'current';
}

/** A PO in a PSI's list of one factory and cell (ADR-021), with its PO PARTIAL (ADR-013). */
export interface PoRow extends Po, Scope {
  partial: PoPartial | null;
  addedAt: string;
}

/** One tap as stored; it carries the username like its session (doc 03 §4.4). */
export type EventRow = SessionEvent & { username: string };

/** One photo per defect of a session (AC-10.5); PSI lv.2 only (AC-10.6). */
export interface PhotoRow {
  sessionId: string;
  defectId: DefectId;
  /** JPEG, ≤ 960 px on the long edge, ≤ 1 MB (doc 03 §4.5). */
  blob: Blob;
  sha256: string;
  takenAt: string;
}

/** Outbox states as listed in the gear menu (AC-11.3, doc 04 §5). */
export type OutboxState = 'waiting' | 'sending' | 'sent' | 'failed';

/** A sealed submission (doc 03 §4.6). `payloadJson` is resent byte for byte. */
export interface OutboxRow {
  submissionUuid: string;
  po: string;
  sealedAt: string;
  payloadJson: string;
  payloadSha256: string;
  /** The author's token travels with the item, so it is sent as its author after another login (doc 03 §4.4). */
  authorUsername: string;
  authorToken: string | null;
  /** When `authorToken` expires; the sender renews it when fewer than 7 days remain (doc 03 §4.4). */
  authorTokenExpiresAt: string | null;
  state: OutboxState;
  attempts: number;
  nextAttemptAt: string;
  lastAttemptAt: string | null;
  /** Reason shown for `failed` (AC-11.3): the API's `detail`. */
  problem: string | null;
  /** The messages of the API's `errors` list for `failed` (doc 04 §5). */
  problemErrors: string[];
  /** The API's submission number, once `sent` (doc 04 §5). */
  displayNo: string | null;
  /** When the API answered `201`/`200`; the item and its photos leave the tablet 7 days later. */
  sentAt: string | null;
}

export interface OutboxPhotoRow {
  submissionUuid: string;
  defectId: DefectId;
  blob: Blob;
  sha256: string;
  takenAt: string;
}

export type Screen = 'home' | 'defect';

/** Where the Defect screen's drill-down is (doc 05 §11.5); `null` above that level. */
export interface DefectPath {
  areaId: AreaId | null;
  subAreaId: string | null;
  familyId: string | null;
}

/**
 * What a PSI was looking at, so a restart returns to the same screen, PO and area path (doc 05 §4, §8.4,
 * §11.5, AC-06.2). Per user, because tablets are shared (BR-09).
 */
export interface View {
  screen: Screen;
  selectedPo: string | null;
  defectPath: DefectPath;
}

export interface ViewRow extends View, Scope {}

/**
 * Whose data a row is: a PSI in one factory and cell (ADR-021). A login with another factory or cell starts with
 * an empty PO list; the data of the first comes back with a later login there. `factory` and `cell` are `''` in a
 * row written before ADR-021, until the PSI's next login claims it (`repo.claimUnscoped`).
 */
export interface Scope {
  username: string;
  factory: string;
  cell: string;
}

/** A session as stored, with its scope. */
export type SessionRow = Session & Scope;

export class M100Db extends Dexie {
  meta!: Table<MetaRow, string>;
  masterData!: Table<MasterDataRow, 'current'>;
  auth!: Table<AuthRow, 'current'>;
  poList!: Table<PoRow, [string, string, string, string]>;
  sessions!: Table<SessionRow, string>;
  events!: Table<EventRow, [string, number]>;
  photos!: Table<PhotoRow, [string, DefectId]>;
  outbox!: Table<OutboxRow, string>;
  outboxPhotos!: Table<OutboxPhotoRow, [string, DefectId]>;
  views!: Table<ViewRow, [string, string, string]>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
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
    // ADR-021: POs, sessions and the screen per factory and cell. A primary key can't change, so `pos` and `view`
    // move to new tables; rows from before stay unscoped (`''`) until their PSI logs in again.
    this.version(2)
      .stores({
        poList: '[username+factory+cell+po], [username+factory+cell], username',
        sessions: 'id, username, [username+factory+cell], [username+factory+cell+po+status]',
        views: '[username+factory+cell], username',
      })
      .upgrade(async (tx) => {
        const unscoped = { factory: '', cell: '' };
        const pos = (await tx.table('pos').toArray()) as Array<Omit<PoRow, 'factory' | 'cell'>>;
        await tx.table('poList').bulkAdd(pos.map((p) => ({ ...p, ...unscoped })));
        const views = (await tx.table('view').toArray()) as Array<
          Omit<ViewRow, 'factory' | 'cell'>
        >;
        await tx.table('views').bulkAdd(views.map((v) => ({ ...v, ...unscoped })));
        await tx
          .table('sessions')
          .toCollection()
          .modify((s: Partial<Scope>) => {
            s.factory ??= '';
            s.cell ??= '';
          });
      });
    this.version(3).stores({ pos: null, view: null });
  }
}

export const DB_NAME = 'm100';

export function createDb(name: string = DB_NAME): M100Db {
  return new M100Db(name);
}
