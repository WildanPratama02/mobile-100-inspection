/**
 * Counting engine (BR-01, BR-02, BR-05, FR-08; ADR-008).
 *
 * A session is the reduction of its event log (doc 03 §4.2). Commands check whether a tap is allowed and
 * return the event to persist; `applyEvent` folds a stored event into the state; totals, findings and the
 * Top 5 are derived from the state, never stored. Everything here is pure.
 */
import type {
  AreaId,
  AreaMapEntry,
  Classification,
  DefectId,
  Finding,
  InspectionCounts,
  InspectionType,
  SessionEvent,
} from './domain';
import type { MappingIndex } from './mapping';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event as a command produces it; the storage layer adds `sessionId`, `seq` and `at`. */
export type SessionEventPayload = DistributiveOmit<SessionEvent, 'sessionId' | 'seq' | 'at'>;

/** One defect tap that has not been undone. */
export interface RecordedDefect extends AreaMapEntry {
  inspectionType: InspectionType;
  at: string;
}

/** The REWORK or B-GRADE inspection in progress, with the defects recorded in it so far. */
export interface ActiveInspection {
  type: InspectionType;
  startedAt: string;
  defects: readonly RecordedDefect[];
}

/** What UNDO would do now (FR-08); each kind has its own toast (doc 05 §11.4). */
export type UndoKind = 'DEFECT' | 'INSPECTION' | 'NO_DEFECT';

export interface SessionState {
  counts: InspectionCounts;
  active: ActiveInspection | null;
  /** Every defect tap that has not been undone, in tap order. */
  recorded: readonly RecordedDefect[];
  /** `null` when UNDO is disabled. */
  undo: UndoKind | null;
}

export const EMPTY_SESSION: SessionState = {
  counts: { rework: 0, bGrade: 0, noDefect: 0 },
  active: null,
  recorded: [],
  undo: null,
};

// ---- Commands: the event to persist, or `null` when the tap is not allowed ----

/** REWORK or B-GRADE. Only one inspection at a time (BR-05). */
export function startInspection(
  state: SessionState,
  type: InspectionType,
): SessionEventPayload | null {
  if (state.active) return null;
  return { type: type === 'REWORK' ? 'START_REWORK' : 'START_BGRADE' };
}

/** NO DEFECT records an A-Grade pair at once (FR-06.3, doc 05 U1). Not while an inspection is active (BR-05). */
export function noDefect(state: SessionState): SessionEventPayload | null {
  if (state.active) return null;
  return { type: 'NO_DEFECT' };
}

/** One finding for the active inspection (AC-06.1). */
export function recordDefect(state: SessionState, entry: AreaMapEntry): SessionEventPayload | null {
  if (!state.active) return null;
  const { areaId, subAreaId, familyId, defectId } = entry;
  return { type: 'DEFECT', areaId, subAreaId, familyId, defectId };
}

export function endInspection(state: SessionState): SessionEventPayload | null {
  if (!state.active) return null;
  return { type: 'END' };
}

export function undo(state: SessionState): SessionEventPayload | null {
  if (!state.undo) return null;
  return { type: 'UNDO' };
}

// ---- Reducer ----

/**
 * Folds one stored event into the state. An event the state does not allow (for example from a damaged
 * log) is ignored, so it can never block the session.
 */
export function applyEvent(state: SessionState, event: SessionEvent): SessionState {
  const { counts, active } = state;
  switch (event.type) {
    case 'START_REWORK':
    case 'START_BGRADE': {
      if (active) return state;
      const type: InspectionType = event.type === 'START_REWORK' ? 'REWORK' : 'B-GRADE';
      return {
        ...state,
        counts: addStarted(counts, type, 1),
        active: { type, startedAt: event.at, defects: [] },
        undo: 'INSPECTION',
      };
    }
    case 'NO_DEFECT':
      if (active) return state;
      return { ...state, counts: { ...counts, noDefect: counts.noDefect + 1 }, undo: 'NO_DEFECT' };
    case 'DEFECT': {
      if (!active) return state;
      const { areaId, subAreaId, familyId, defectId } = event;
      const defect: RecordedDefect = {
        areaId,
        subAreaId,
        familyId,
        defectId,
        inspectionType: active.type,
        at: event.at,
      };
      return {
        ...state,
        active: { ...active, defects: [...active.defects, defect] },
        recorded: [...state.recorded, defect],
        undo: 'DEFECT',
      };
    }
    case 'END':
      if (!active) return state;
      return { ...state, active: null, undo: null };
    case 'UNDO':
      return applyUndo(state);
  }
}

/**
 * FR-08: the last defect of the active inspection; with none, the inspection itself; right after
 * NO DEFECT, that NO DEFECT. A cancelled inspection or NO DEFECT leaves UNDO disabled, so it never
 * reaches an ended inspection or an earlier NO DEFECT.
 */
function applyUndo(state: SessionState): SessionState {
  const { counts, active } = state;
  switch (state.undo) {
    case 'DEFECT': {
      if (!active) return state;
      const defects = active.defects.slice(0, -1);
      return {
        ...state,
        active: { ...active, defects },
        recorded: state.recorded.slice(0, -1),
        undo: defects.length > 0 ? 'DEFECT' : 'INSPECTION',
      };
    }
    case 'INSPECTION':
      if (!active) return state;
      return { ...state, counts: addStarted(counts, active.type, -1), active: null, undo: null };
    case 'NO_DEFECT':
      return { ...state, counts: { ...counts, noDefect: counts.noDefect - 1 }, undo: null };
    case null:
      return state;
  }
}

function addStarted(counts: InspectionCounts, type: InspectionType, n: number): InspectionCounts {
  return type === 'REWORK'
    ? { ...counts, rework: counts.rework + n }
    : { ...counts, bGrade: counts.bGrade + n };
}

export function replay(events: readonly SessionEvent[]): SessionState {
  return events.reduce(applyEvent, EMPTY_SESSION);
}

// ---- Derived values ----

/**
 * Findings per inspection type + area + sub-area + defect (doc 04 §4.1, rule 5), in order of their first
 * tap.
 */
export function findings(state: SessionState): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const d of state.recorded) {
    const key = [d.inspectionType, d.areaId, d.subAreaId, d.defectId].join('|');
    const found = byKey.get(key);
    if (found) {
      found.qty += 1;
    } else {
      byKey.set(key, {
        inspectionType: d.inspectionType,
        areaId: d.areaId,
        subAreaId: d.subAreaId,
        familyId: d.familyId,
        defectId: d.defectId,
        qty: 1,
        firstRecordedAt: d.at,
      });
    }
  }
  return [...byKey.values()];
}

export interface Totals {
  qtyInspection: number;
  qtyAGrade: number;
  qtyDefect: number;
  qtyBGrade: number;
  /** Qty Defect ÷ Qty Inspection (BR-02); can exceed 1. `null` when Qty Inspection is 0. */
  defectRate: number | null;
  /** Pass Rate (RFT) = Qty A-Grade ÷ Qty Inspection (BR-02). `null` when Qty Inspection is 0. */
  passRate: number | null;
}

/** ADR-008 totals from what happened (doc 04 §4.1). The API computes the same from the submission. */
export function computeTotals(counts: InspectionCounts, list: readonly Finding[]): Totals {
  const qtyInspection = counts.rework + counts.bGrade + counts.noDefect;
  const qtyAGrade = counts.noDefect;
  let qtyDefect = 0;
  let qtyBGrade = 0;
  for (const f of list) {
    qtyDefect += f.qty;
    if (f.inspectionType === 'B-GRADE') qtyBGrade += f.qty;
  }
  const rate = (n: number) => (qtyInspection === 0 ? null : n / qtyInspection);
  return {
    qtyInspection,
    qtyAGrade,
    qtyDefect,
    qtyBGrade,
    defectRate: rate(qtyDefect),
    passRate: rate(qtyAGrade),
  };
}

export function totals(state: SessionState): Totals {
  return computeTotals(state.counts, findings(state));
}

/** One defect with its quantity summed across areas, sub-areas and inspection types (doc 02 §6.1). */
export interface RankedDefect {
  defectId: DefectId;
  classification: Classification;
  qty: number;
  /** Areas it was found in, in order of first tap. */
  areaIds: AreaId[];
  firstRecordedAt: string;
}

const SEVERITY: Readonly<Record<Classification, number>> = { CRITICAL: 0, MAJOR: 1, MINOR: 2 };

/**
 * Defects in ranking order (AC-05.1, doc 02 §8 `v_defect_totals`): higher quantity, then CRITICAL > MAJOR > MINOR, then the
 * defect recorded first. Grouped by `DEFECT_ID`, never by name (ADR-009).
 */
export function rankDefects(
  list: readonly Finding[],
  classificationOf: (id: DefectId) => Classification,
): RankedDefect[] {
  const byDefect = new Map<DefectId, RankedDefect>();
  const ordered = [...list].sort(
    (a, b) => Date.parse(a.firstRecordedAt) - Date.parse(b.firstRecordedAt),
  );
  for (const f of ordered) {
    const found = byDefect.get(f.defectId);
    if (found) {
      found.qty += f.qty;
      if (!found.areaIds.includes(f.areaId)) found.areaIds.push(f.areaId);
    } else {
      byDefect.set(f.defectId, {
        defectId: f.defectId,
        classification: classificationOf(f.defectId),
        qty: f.qty,
        areaIds: [f.areaId],
        firstRecordedAt: f.firstRecordedAt,
      });
    }
  }
  // Map order is first-recorded order and the sort is stable, so it settles the last tie.
  return [...byDefect.values()].sort(
    (a, b) => b.qty - a.qty || SEVERITY[a.classification] - SEVERITY[b.classification],
  );
}

/**
 * TOP 5 DEFECT (FR-05, doc 03 §5.5): Home on the tablet, the photo check and Top 5 on the API, from the same
 * findings. `defects` is the mapping on the tablet and the master `defects` table on the API.
 */
export function top5(
  list: readonly Finding[],
  defects: Pick<MappingIndex, 'defect'>,
): RankedDefect[] {
  return rankDefects(list, (id) => {
    const defect = defects.defect(id);
    if (!defect) throw new Error(`Unknown defect ${id}`);
    return defect.classification;
  }).slice(0, 5);
}
