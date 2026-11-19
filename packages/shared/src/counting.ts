/**
 * Counting engine (BR-01, BR-02, BR-05, BR-10, FR-08, FR-15; ADR-019, ADR-021, ADR-023).
 *
 * A session is the reduction of its event log (doc 03 §4.2). Commands check whether a tap is allowed and
 * return the event to persist; `applyEvent` folds a stored event into the state; totals, findings and the
 * Top 5 are derived from the state, never stored. Everything here is pure.
 *
 * Two counting modes (ADR-021): PSI lv.1 enters Qty Inspection (`ENTERED`, ADR-019); PSI lv.2 counts it with
 * taps (`TAPPED`): NO DEFECT adds an A-Grade pair, each ended REWORK or B-GRADE inspection a pair with a defect;
 * the PSI can also set the NO DEFECT total with the number pad (ADR-023).
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
  PsiLevel,
  SessionEvent,
  SubmissionCounts,
} from './domain';

/** How a session gets its Qty Inspection (ADR-021). */
export type CountingMode = 'ENTERED' | 'TAPPED';

/** PSI lv.1 enters Qty Inspection; PSI lv.2 counts it with NO DEFECT and END INSPECTION (ADR-021). */
export function countingMode(level: PsiLevel): CountingMode {
  return level === 'PSI lv.2' ? 'TAPPED' : 'ENTERED';
}

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

/**
 * What UNDO would do now (FR-08); each kind has its own toast (doc 05 §11.4). `TAPPED` only: NO_DEFECT takes back
 * one tapped pair, SET_NO_DEFECT a set total (back to the total before it, ADR-023).
 */
export type UndoKind = 'DEFECT' | 'INSPECTION' | 'NO_DEFECT' | 'SET_NO_DEFECT';

/** One step of the NO DEFECT run (`TAPPED`): a NO DEFECT tap, or a set total with the total before it (ADR-023). */
export type NoDefectStep = { kind: 'TAP' } | { kind: 'SET'; before: number };

export interface SessionState {
  mode: CountingMode;
  /** REWORK and B-GRADE inspections started, the active one included. */
  counts: InspectionCounts;
  /** NO DEFECT pairs (`TAPPED`), tapped or set as a total (ADR-023); always 0 in `ENTERED`. */
  noDefect: number;
  /**
   * The steps of the latest NO DEFECT run not undone yet (`TAPPED`), oldest first: how far UNDO may still go
   * back, one step per UNDO. A REWORK / B-GRADE start ends the run, so UNDO never reaches an ended inspection
   * (FR-08, ADR-023). Derived from the events; nothing extra is stored.
   */
  noDefectRun: readonly NoDefectStep[];
  /** Entered by the PSI (FR-15, `ENTERED`); `null` until the first SET_QTY_INSPECTION, always in `TAPPED`. */
  qtyInspection: number | null;
  /** Entered approval for both PSI levels (FR-16); null is empty, counted as 0 in report figures. */
  reworkApproved: number | null;
  active: ActiveInspection | null;
  /** Every defect tap that has not been undone, in tap order. */
  recorded: readonly RecordedDefect[];
  /** `null` when UNDO is disabled. */
  undo: UndoKind | null;
}

export function emptySession(mode: CountingMode): SessionState {
  return {
    mode,
    counts: { rework: 0, bGrade: 0 },
    noDefect: 0,
    noDefectRun: [],
    qtyInspection: null,
    reworkApproved: null,
    active: null,
    recorded: [],
    undo: null,
  };
}

/** An empty PSI lv.1 session (`ENTERED`). */
export const EMPTY_SESSION: SessionState = emptySession('ENTERED');

/**
 * `TAPPED`: every pair tapped so far, the active inspection included. NO DEFECT, REWORK and B-GRADE are refused
 * once this reaches the partial quantity or Qty Order (ADR-021).
 */
export function tappedPairs(state: SessionState): number {
  return state.noDefect + state.counts.rework + state.counts.bGrade;
}

/** `TAPPED`: whether one more pair is allowed for this PO (ADR-021). Always true in `ENTERED`. */
export function canAddPair(state: SessionState, po: PoQuantities): boolean {
  return state.mode !== 'TAPPED' || tappedPairs(state) < (po.partial?.qty ?? po.orderQty);
}

/**
 * `TAPPED`: the highest NO DEFECT total the PSI can set (ADR-023 decision 4): the partial quantity, else Qty
 * Order, minus the REWORK and B-GRADE pairs counted, never below 0. `null` in `ENTERED`.
 */
export function noDefectMax(state: SessionState, po: PoQuantities): number | null {
  if (state.mode !== 'TAPPED') return null;
  const max = po.partial?.qty ?? po.orderQty;
  return Math.max(0, max - state.counts.rework - state.counts.bGrade);
}

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
  if (min > max) return { kind: 'IMPOSSIBLE', min, max };
  if (qty === null) return { kind: 'EMPTY' };
  if (qty < min) return { kind: 'BELOW', min };
  if (qty > max) return { kind: 'ABOVE', max };
  return null;
}

// ---- Commands: the event to persist, or `null` when the tap is not allowed ----

/**
 * REWORK or B-GRADE. Only one inspection at a time (BR-05). With `po`, `TAPPED` refuses a pair above the PO's
 * maximum (ADR-021).
 */
export function startInspection(
  state: SessionState,
  type: InspectionType,
  po?: PoQuantities,
): SessionEventPayload | null {
  if (state.active) return null;
  if (po && !canAddPair(state, po)) return null;
  return { type: type === 'REWORK' ? 'START_REWORK' : 'START_BGRADE' };
}

/** NO DEFECT (`TAPPED` only): one A-Grade pair at once, outside an inspection, up to the maximum (ADR-021). */
export function noDefect(state: SessionState, po: PoQuantities): SessionEventPayload | null {
  if (state.mode !== 'TAPPED' || state.active || !canAddPair(state, po)) return null;
  return { type: 'NO_DEFECT' };
}

/**
 * SIMPAN in the NO DEFECT dialog (`TAPPED` only, ADR-023): the new NO DEFECT total, a whole number from 0 to
 * `noDefectMax`, outside an inspection. Allowed also when the maximum is already reached or exceeded, so the
 * PSI can lower it (which clears ABOVE). An unchanged value returns no event.
 */
export function setNoDefect(
  state: SessionState,
  qty: number,
  po: PoQuantities,
): SessionEventPayload | null {
  const max = noDefectMax(state, po);
  if (max === null || state.active || !Number.isInteger(qty) || qty < 0 || qty > max) return null;
  if (qty === state.noDefect) return null;
  return { type: 'SET_NO_DEFECT', qty };
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

/**
 * END INSPECTION: refused until the active inspection has a finding, also after UNDO of its last finding
 * (AC-06.3, ADR-022 decision 8). `applyEvent` still folds a stored END of an empty inspection from an older
 * session, so its replay never changes.
 */
export function endInspection(state: SessionState): SessionEventPayload | null {
  if (!state.active || state.active.defects.length === 0) return null;
  return { type: 'END' };
}

export function undo(state: SessionState): SessionEventPayload | null {
  if (!state.undo) return null;
  return { type: 'UNDO' };
}

/**
 * SIMPAN in the QTY INSPECTION dialog (FR-15, `ENTERED` only): only a whole number valid for the session now
 * (BR-10).
 */
export function setQtyInspection(
  state: SessionState,
  qty: number,
  po: PoQuantities,
): SessionEventPayload | null {
  if (state.mode !== 'ENTERED' || !Number.isInteger(qty)) return null;
  const { qtyDefect } = defectTotals(findings(state));
  const limits = qtyInspectionLimits(qtyDefect, po.partial, po.orderQty);
  if (checkQtyInspection(qty, limits)) return null;
  return { type: 'SET_QTY_INSPECTION', qty };
}

/** BR-11: a saved approval can become too high when UNDO cancels a REWORK start. */
export type ReworkApprovedIssue = { kind: 'ABOVE'; max: number };

export function checkReworkApproved(state: SessionState): ReworkApprovedIssue | null {
  return (state.reworkApproved ?? 0) > state.counts.rework
    ? { kind: 'ABOVE', max: state.counts.rework }
    : null;
}

/** SIMPAN in REWORK AND APPROVED (FR-16). Empty is saved as null; UNDO history is untouched. */
export function setReworkApproved(
  state: SessionState,
  qty: number | null,
): SessionEventPayload | null {
  if (qty !== null && (!Number.isInteger(qty) || qty < 0 || qty > state.counts.rework)) return null;
  if (state.counts.rework === 0 && !checkReworkApproved(state)) return null;
  return { type: 'SET_REWORK_APPROVED', qty };
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
        noDefectRun: [],
        undo: 'INSPECTION',
      };
    }
    case 'NO_DEFECT':
      // `ENTERED`: left by an app version from before ADR-019 in a session that was open during the update; it
      // changes no figure and no UNDO state (ADR-019 decision 9). `TAPPED`: one A-Grade pair (ADR-021).
      if (state.mode !== 'TAPPED' || active) return state;
      return {
        ...state,
        noDefect: state.noDefect + 1,
        noDefectRun: [...state.noDefectRun, { kind: 'TAP' }],
        undo: 'NO_DEFECT',
      };
    case 'SET_NO_DEFECT':
      // `TAPPED` only (ADR-023); `ENTERED` ignores it as it ignores NO_DEFECT. The maximum is checked by
      // `setNoDefect`; the reducer has no PO and folds any whole number that changes the total.
      if (state.mode !== 'TAPPED' || active) return state;
      if (!Number.isInteger(event.qty) || event.qty < 0 || event.qty === state.noDefect)
        return state;
      return {
        ...state,
        noDefect: event.qty,
        noDefectRun: [...state.noDefectRun, { kind: 'SET', before: state.noDefect }],
        undo: 'SET_NO_DEFECT',
      };
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
      // Leaves `undo` alone: changing Qty Inspection never touches the UNDO history (FR-08). `TAPPED` counts
      // it from taps, so a value entered before ADR-021 is ignored there.
      if (state.mode !== 'ENTERED' || !Number.isInteger(event.qty) || event.qty < 1) return state;
      return { ...state, qtyInspection: event.qty };
    case 'SET_REWORK_APPROVED':
      if (event.qty !== null && (!Number.isInteger(event.qty) || event.qty < 0)) return state;
      return { ...state, reworkApproved: event.qty };
  }
}

/**
 * FR-08: the last defect of the active inspection; with none, the inspection itself; after NO DEFECT (`TAPPED`),
 * one step per UNDO back through the latest NO DEFECT run (10 Nov 2026, ADR-023): a tap gives back one pair, a
 * set total returns to the total before it. A cancelled inspection leaves UNDO disabled, so it never reaches an
 * ended inspection. An entered Qty Inspection is never changed.
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
    case 'SET_NO_DEFECT': {
      const step = state.noDefectRun.at(-1);
      if (active || !step) return state;
      if (step.kind === 'TAP' && state.noDefect < 1) return state;
      const noDefectRun = state.noDefectRun.slice(0, -1);
      return {
        ...state,
        noDefect: step.kind === 'TAP' ? state.noDefect - 1 : step.before,
        noDefectRun,
        undo: undoOfRun(noDefectRun),
      };
    }
    case null:
      return state;
  }
}

/** The UNDO kind for the latest step of a NO DEFECT run; `null` once the run is empty. */
function undoOfRun(run: readonly NoDefectStep[]): UndoKind | null {
  const last = run.at(-1);
  if (!last) return null;
  return last.kind === 'TAP' ? 'NO_DEFECT' : 'SET_NO_DEFECT';
}

function addStarted(counts: InspectionCounts, type: InspectionType, n: number): InspectionCounts {
  return type === 'REWORK'
    ? { ...counts, rework: counts.rework + n }
    : { ...counts, bGrade: counts.bGrade + n };
}

/** The session of a PSI lv.1 (`ENTERED`, the default) or PSI lv.2 (`TAPPED`) from its stored events. */
export function replay(
  events: readonly SessionEvent[],
  mode: CountingMode = 'ENTERED',
): SessionState {
  return events.reduce(applyEvent, emptySession(mode));
}

// ---- Derived values ----

/**
 * Findings per inspection type + area + sub-area + defect (doc 04 §4.1, rule 5), in order of their first
 * tap, for a list of recorded defects.
 */
export function findingsOf(defects: readonly RecordedDefect[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const d of defects) {
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

/**
 * Findings per inspection type + area + sub-area + defect (doc 04 §4.1, rule 5) of the whole session, in
 * order of their first tap: what Home and the exports show.
 */
export function findings(state: SessionState): Finding[] {
  return findingsOf(state.recorded);
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

/**
 * `ADR-019` for a Qty Inspection entered by the PSI; `ADR-008` for tapped counts: PSI lv.2 (ADR-021) or a
 * payload sealed before ADR-019.
 */
export function countingRule(counts: SubmissionCounts): CountingRule {
  return counts.noDefect === undefined ? 'ADR-019' : 'ADR-008';
}

/**
 * Totals from what happened (doc 04 §4.1). ADR-019: Qty A-Grade = Qty Inspection − Qty Defect. Tapped counts
 * (PSI lv.2, ADR-021, or a payload sealed before ADR-019) follow ADR-008: Qty Inspection = all inspections +
 * NO DEFECT, Qty A-Grade = NO DEFECT. The API computes these from the submission; the outbox compares them with
 * the API's answer.
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
interface InspectionTotals {
  /**
   * `ENTERED`: entered by the PSI; `null` until entered (shown "—"). `TAPPED`: NO DEFECT taps + ended REWORK
   * and B-GRADE inspections (a pair counts at END INSPECTION, ADR-021).
   */
  qtyInspection: number | null;
  qtyDefect: number;
  qtyBGrade: number;
  /**
   * `ENTERED`: Qty Inspection − Qty Defect, and the rates of BR-02; `null` while Qty Inspection is empty or not
   * valid; the screen then shows `0` and `0,0%` (ADR-019 decision 7). Never submitted. `TAPPED`: the NO DEFECT
   * pairs (tapped or set, ADR-023), and rates once a pair is counted (ADR-021).
   */
  qtyAGrade: number | null;
  defectRate: number | null;
  passRate: number | null;
  /**
   * Why Qty Inspection is not valid (BR-10); `null` when it is. `TAPPED`: only ABOVE, when the pairs tapped
   * are more than the partial quantity or Qty Order (for example after the partial was lowered).
   */
  qtyInspectionIssue: QtyInspectionIssue | null;
}

/** Existing ADR-019 / ADR-021 counting figures, independent of report-only rework approval. */
function inspectionTotals(state: SessionState, po?: PoQuantities): InspectionTotals {
  const { qtyDefect, qtyBGrade } = defectTotals(findings(state));
  if (state.mode === 'TAPPED') {
    const qtyInspection = tappedPairs(state) - (state.active ? 1 : 0);
    const max = po ? (po.partial?.qty ?? po.orderQty) : Number.POSITIVE_INFINITY;
    const rate = (n: number) => (qtyInspection === 0 ? null : n / qtyInspection);
    return {
      qtyInspection,
      qtyDefect,
      qtyBGrade,
      qtyAGrade: state.noDefect,
      defectRate: rate(qtyDefect),
      passRate: rate(state.noDefect),
      qtyInspectionIssue: tappedPairs(state) > max ? { kind: 'ABOVE', max } : null,
    };
  }
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

/** Report figures (ADR-022 decision 7). Null dependent figures display as 0 / 0,0%. */
export interface SessionTotals extends InspectionTotals {
  inspectionReworkQty: number;
  reworkApproved: number | null;
  reworkApprovedIssue: ReworkApprovedIssue | null;
  inspectedQtyInclRework: number | null;
  rejectedQty: number | null;
  totalApprovedQty: number | null;
  notReworkableRate: number | null;
  /** Null without a PO; otherwise partial quantity, or Qty Order. */
  offeredLotQty: number | null;
  balanceQty: number | null;
  balanceRework: number | null;
}

/** Without `po` the upper limit of BR-10 is not checked and lot-dependent figures are null. */
export function totals(state: SessionState, po?: PoQuantities): SessionTotals {
  const base = inspectionTotals(state, po);
  const qty = state.mode === 'ENTERED' && base.qtyInspectionIssue ? null : base.qtyInspection;
  const inspectionReworkQty = state.counts.rework;
  const reworkApprovedIssue = checkReworkApproved(state);
  const approved = reworkApprovedIssue ? null : (state.reworkApproved ?? 0);
  const offeredLotQty = po ? (po.partial?.qty ?? po.orderQty) : null;
  return {
    ...base,
    inspectionReworkQty,
    reworkApproved: state.reworkApproved,
    reworkApprovedIssue,
    inspectedQtyInclRework:
      qty === null ? null : qty + (state.mode === 'ENTERED' ? inspectionReworkQty : 0),
    rejectedQty: qty === null || base.qtyAGrade === null ? null : qty - base.qtyAGrade,
    totalApprovedQty:
      base.qtyAGrade === null || approved === null ? null : base.qtyAGrade + approved,
    notReworkableRate: qty === null || qty === 0 ? null : base.qtyBGrade / qty,
    offeredLotQty,
    balanceQty: offeredLotQty === null || qty === null ? null : offeredLotQty - qty,
    balanceRework: approved === null ? null : inspectionReworkQty - approved,
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

/** ALL DEFECT (FR-05, ADR-022): the full ranking, keyed by DEFECT_ID. */
export function allDefects(list: readonly Finding[], defects: DefectLookup): RankedDefect[] {
  return rankDefects(list, (id) => {
    const defect = defects.defect(id);
    if (!defect) throw new Error(`Unknown defect ${id}`);
    return defect.classification;
  });
}

/** The first five ranked defects, retained for legacy photo rules and the admin Top 5. */
export function top5(list: readonly Finding[], defects: DefectLookup): RankedDefect[] {
  return allDefects(list, defects).slice(0, 5);
}
