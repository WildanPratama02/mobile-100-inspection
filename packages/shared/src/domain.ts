/**
 * Domain types shared by the PWA and the API.
 *
 * Shapes follow the schemas of docs/04-openapi.yaml; the session event log follows
 * doc 03 §4.2. Types only: the rules that act on them live in their own modules.
 */

/** PSI level as stored in USER_LIST and sent at login. */
export type PsiLevel = 'PSI lv.1' | 'PSI lv.2';

export interface User {
  username: string;
  level: PsiLevel;
}

/** A factory of the form `F <number>` with its cells (doc 02 §3.2). */
export interface Factory {
  factory: string;
  cells: string[];
}

/** The factory and cell a PSI logs in to. */
export interface Cell {
  factory: string;
  cell: string;
}

/** One PO from ALL_PO_MASTER. Dates are `YYYY-MM-DD`, or `null` when the cell is empty. */
export interface Po {
  po: string;
  article: string;
  /** Byte for byte from ALL_PO_MASTER (may contain U+00A0). */
  model: string;
  destination: string;
  orderQty: number;
  podd: string | null;
  crd: string | null;
}

/** PO PARTIAL (ADR-013): partial number (1 = P1) and its quantity. */
export interface PoPartial {
  number: number;
  qty: number;
}

/** A01–A12. */
export type AreaId = `A${string}`;

/** D001–D098 (ADR-009). The only key for a defect: names are not unique. */
export type DefectId = `D${string}`;

/** Severity from DEFECT_LIST.CLASSIFICATION (doc 02 §3.4). */
export type Classification = 'MINOR' | 'MAJOR' | 'CRITICAL';

export interface SubArea {
  id: string;
  name: string;
  /** Display order across all sub-areas. */
  order: number;
}

export interface Area {
  id: AreaId;
  name: string;
  /** Display order, 1–12. */
  order: number;
  subAreas: SubArea[];
}

export interface Family {
  id: string;
  name: string;
}

export interface Defect {
  id: DefectId;
  /** Exactly as in the mapping (case and brackets kept). */
  name: string;
  classification: Classification;
  familyId: string;
}

/** One area + sub-area + family + defect combination of M100_AREA_MAP. */
export interface AreaMapEntry {
  areaId: AreaId;
  subAreaId: string;
  familyId: string;
  defectId: DefectId;
}

/** An active row of M100_AREA_MAP as served by `GET /master-data`. */
export interface AreaMapRow extends AreaMapEntry {
  mapId: string;
}

export type InspectionType = 'REWORK' | 'B-GRADE';

/** A PSI's working session on one PO, on one tablet (doc 03 §4.2, §4.6). */
export interface Session {
  id: string;
  username: string;
  po: string;
  status: 'open' | 'closed';
  createdAt: string;
}

/** Fields every stored event carries. Key in IndexedDB: `[sessionId, seq]`. */
interface SessionEventBase {
  sessionId: string;
  seq: number;
  /** ISO 8601 timestamp of the tap. */
  at: string;
}

/** One tap, persisted before the UI shows its effect (NFR-05). A session is the reduction of its events. */
export type SessionEvent = SessionEventBase &
  (
    | { type: 'START_REWORK' }
    | { type: 'START_BGRADE' }
    | { type: 'NO_DEFECT' }
    | ({ type: 'DEFECT' } & AreaMapEntry)
    | { type: 'END' }
    | { type: 'UNDO' }
  );

export type SessionEventType = SessionEvent['type'];

/** A REWORK or B-GRADE inspection, derived from the events; `endedAt` is `null` while active. */
export interface Inspection {
  type: InspectionType;
  startedAt: string;
  endedAt: string | null;
}

/** One area + sub-area + defect + inspection type with its total quantity (AC-09.2, doc 04 §4.1). */
export interface Finding extends AreaMapEntry {
  inspectionType: InspectionType;
  qty: number;
  /** Breaks ties in slot order (doc 02 §6.2). */
  firstRecordedAt: string;
}

/** Number of inspections started, by type (ADR-008, doc 04 §4.1 `counts`). */
export interface InspectionCounts {
  rework: number;
  bGrade: number;
  noDefect: number;
}
