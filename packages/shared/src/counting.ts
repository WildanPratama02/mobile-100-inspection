/**
 * Counting engine (BR-01, BR-02, BR-05, BR-10, FR-08, FR-15; ADR-019).
 *
 * A session is the reduction of its event log (doc 03 §4.2). Commands check whether a tap is allowed and
 * return the event to persist; `applyEvent` folds a stored event into the state; totals, findings and the
 * Top 5 are derived from the state, never stored. Everything here is pure.
 */
import type {
  AreaId,
  AreaMapEntry,
  Classification,
  CountingRule,
  DefectId,
  Finding,
  InspectionCounts,
  InspectionType,
  PoPartial,
  SessionEvent,
  SubmissionCounts,
} from './domain';

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
export type UndoKind = 'DEFECT' | 'INSPECTION';

export interface SessionState {
  counts: InspectionCounts;
  /** Entered by the PSI (FR-15); `null` until the first SET_QTY_INSPECTION. */
  qtyInspection: number | null;
  active: ActiveInspection | null;
  /** Every defect tap that has not been undone, in tap order. */
  recorded: readonly RecordedDefect[];
  /** `null` when UNDO is disabled. */
  undo: UndoKind | null;
}

export const EMPTY_SESSION: SessionState = {
  counts: { rework: 0, bGrade: 0 },
  qtyInspection: null,
  active: null,
  recorded: [],
  undo: null,
};

/** The PO quantities that bound Qty Inspection (BR-10). */
export interface PoQuantities {
  orderQty: number;
  partial: PoPartial | null;
}

/** Valid Qty Inspection is a whole number from `min` to `max` (BR-10). */
export interface QtyInspectionLimits {
  min: number;
  max: number;
}

/** Why a Qty Inspection is not valid (BR-10); each has its own message (doc 05 §8.2, §13.1, §15). */
export type QtyInspectionIssue =
  | { kind: 'EMPTY' }
  /** Qty Defect is above the partial quantity or Qty Order: no value is valid. */
  | { kind: 'IMPOSSIBLE'; min: number; max: number }
  | { kind: 'BELOW'; min: number }
  | { kind: 'ABOVE'; max: number };

/** BR-10: at least 1 and at least Qty Defect; at most the partial quantity, otherwise Qty Order. */
export function qtyInspectionLimits(
  qtyDefect: number,
  partial: PoPartial | null,
  orderQty: number,
): QtyInspectionLimits {
  return { min: Math.max(1, qtyDefect), max: partial?.qty ?? orderQty };
}

/** `null` when `qty` is a valid Qty Inspection for these limits. */
export function checkQtyInspection(
  qty: number | null,
  { min, max }: QtyInspectionLimits,
): QtyInspectionIssue | null {
  if (qty === null) return { kind: 'EMPTY' };
  if (min > max) return { kind: 'IMPOSSIBLE', min, max };
  if (qty < min) return { kind: 'BELOW', min };
  if (qty > max) return { kind: 'ABOVE', max };
  return null;
}

// ---- Commands: the event to persist, or `null` when the tap is not allowed ----

/** REWORK or B-GRADE. Only one inspection at a time (BR-05). */
export function startInspection(
  state: SessionState,
  type: InspectionType,
): SessionEventPayload | null {
  if (state.active) return null;
  return { type: type === 'REWORK' ? 'START_REWORK' : 'START_BGRADE' };
}

/**
 * One finding for the active inspection (AC-06.1). Never refused because of Qty Inspection, even when the
 * finding makes it not valid (ADR-019 decision 6).
 */
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

/** SIMPAN in the QTY INSPECTION dialog (FR-15): only a whole number valid for the session now (BR-10). */
export function setQtyInspection(
  state: SessionState,
  qty: number,
  po: PoQuantities,
): SessionEventPayload | null {
  if (!Number.isInteger(qty)) return null;
  const { qtyDefect } = defectTotals(findings(state));
  const limits = qtyInspectionLimits(qtyDefect, po.partial, po.orderQty);
  if (checkQtyInspection(qty, limits)) return null;
  return { type: 'SET_QTY_INSPECTION', qty };
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
      // Left by an app version from before ADR-019 in a session that was open during the update: it changes
      // no figure and no UNDO state (ADR-019 decision 9).
      return state;
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
    case 'SET_QTY_INSPECTION':
      // Leaves `undo` alone: changing Qty Inspection never touches the UNDO history (FR-08).
      if (!Number.isInteger(event.qty) || event.qty < 1) return state;
      return { ...state, qtyInspection: event.qty };
  }
}

/**
 * FR-08: the last defect of the active inspection; with none, the inspection itself. A cancelled inspection
 * leaves UNDO disabled, so it never reaches an ended inspection. Qty Inspection is never changed.
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

/** Qty Defect counts defect findings, not defective pairs; Qty B-Grade the B-GRADE ones (BR-01). */
function defectTotals(list: readonly Finding[]): { qtyDefect: number; qtyBGrade: number } {
  let qtyDefect = 0;
  let qtyBGrade = 0;
  for (const f of list) {
    qtyDefect += f.qty;
    if (f.inspectionType === 'B-GRADE') qtyBGrade += f.qty;
  }
  return { qtyDefect, qtyBGrade };
}

/** The totals of a submission (doc 04 §4.1): what the API stores and returns. */
export interface Totals {
  qtyInspection: number;
  qtyAGrade: number;
  qtyDefect: number;
  qtyBGrade: number;
  /** Qty Defect ÷ Qty Inspection (BR-02). `null` when Qty Inspection is 0. */
  defectRate: number | null;
  /** Pass Rate (RFT) = Qty A-Grade ÷ Qty Inspection (BR-02). `null` when Qty Inspection is 0. */
  passRate: number | null;
}

/** `ADR-019` for a Qty Inspection entered by the PSI, `ADR-008` for a payload sealed before the update. */
export function countingRule(counts: SubmissionCounts): CountingRule {
  return counts.noDefect === undefined ? 'ADR-019' : 'ADR-008';
}

/**
 * Totals from what happened (doc 04 §4.1). ADR-019: Qty A-Grade = Qty Inspection − Qty Defect. A payload
 * sealed under ADR-008 keeps the ADR-008 rules: Qty Inspection = all inspections started, Qty A-Grade =
 * NO DEFECT. The API computes these from the submission; the outbox compares them with the API's answer.
 */
export function computeTotals(counts: SubmissionCounts, list: readonly Finding[]): Totals {
  const { qtyDefect, qtyBGrade } = defectTotals(list);
  let qtyInspection: number;
  let qtyAGrade: number;
  if (counts.noDefect === undefined) {
    qtyInspection = counts.qtyInspection;
    qtyAGrade = qtyInspection - qtyDefect;
  } else {
    qtyInspection = counts.rework + counts.bGrade + counts.noDefect;
    qtyAGrade = counts.noDefect;
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

/** The session's figures on Home and in the exports (FR-04). */
export interface SessionTotals {
  /** Entered by the PSI; `null` until entered (shown "—"). */
  qtyInspection: number | null;
  qtyDefect: number;
  qtyBGrade: number;
  /**
   * Qty Inspection − Qty Defect, and the rates of BR-02. `null` while Qty Inspection is empty or not valid;
   * the screen then shows `0` and `0,0%` (ADR-019 decision 7). Never submitted.
   */
  qtyAGrade: number | null;
  defectRate: number | null;
  passRate: number | null;
  /** Why Qty Inspection is not valid (BR-10); `null` when it is. */
  qtyInspectionIssue: QtyInspectionIssue | null;
}

/** Without `po` the upper limit of BR-10 is not checked. */
export function totals(state: SessionState, po?: PoQuantities): SessionTotals {
  const { qtyDefect, qtyBGrade } = defectTotals(findings(state));
  const { qtyInspection } = state;
  const limits = qtyInspectionLimits(
    qtyDefect,
    po?.partial ?? null,
    po?.orderQty ?? Number.POSITIVE_INFINITY,
  );
  const qtyInspectionIssue = checkQtyInspection(qtyInspection, limits);
  if (qtyInspection === null || qtyInspectionIssue) {
    return {
      qtyInspection,
      qtyDefect,
      qtyBGrade,
      qtyAGrade: null,
      defectRate: null,
      passRate: null,
      qtyInspectionIssue,
    };
  }
  const qtyAGrade = qtyInspection - qtyDefect;
  return {
    qtyInspection,
    qtyDefect,
    qtyBGrade,
    qtyAGrade,
    defectRate: qtyDefect / qtyInspection,
    passRate: qtyAGrade / qtyInspection,
    qtyInspectionIssue: null,
  };
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

/** The severity of a defect by id: the mapping (`MappingIndex`) on the tablet, the `defects` table on the API. */
export interface DefectLookup {
  defect(id: string): { classification: Classification } | undefined;
}

/**
 * TOP 5 DEFECT (FR-05, doc 03 §5.5): Home on the tablet, the photo check and Top 5 on the API, from the same
 * findings.
 */
export function top5(list: readonly Finding[], defects: DefectLookup): RankedDefect[] {
  return rankDefects(list, (id) => {
    const defect = defects.defect(id);
    if (!defect) throw new Error(`Unknown defect ${id}`);
    return defect.classification;
  }).slice(0, 5);
}
