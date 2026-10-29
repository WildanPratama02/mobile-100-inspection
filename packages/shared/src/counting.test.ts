import { describe, expect, it } from 'vitest';
import {
  EMPTY_SESSION,
  applyEvent,
  canAddPair,
  checkQtyInspection,
  computeTotals,
  countingMode,
  countingRule,
  emptySession,
  endInspection,
  findings,
  noDefect,
  qtyInspectionLimits,
  rankDefects,
  recordDefect,
  replay,
  setQtyInspection,
  startInspection,
  top5,
  totals,
  undo,
  type CountingMode,
  type PoQuantities,
  type SessionEventPayload,
  type SessionState,
  type SessionTotals,
} from './counting';
import type { AreaMapEntry, DefectId, Finding, InspectionType, SessionEvent } from './domain';
import { defaultMapping } from './mapping';

const mapping = defaultMapping();

/** A PO large enough not to bound Qty Inspection, unless a test says otherwise. */
const PO: PoQuantities = { orderQty: 10_002, partial: null };

/** A real M100_AREA_MAP entry for the defect, optionally in a given area. */
function entry(defectId: string, areaId?: string): AreaMapEntry {
  const found = mapping.map.find(
    (e) => e.defectId === defectId && (areaId === undefined || e.areaId === areaId),
  );
  if (!found) throw new Error(`No map entry for ${defectId} in ${areaId ?? 'any area'}`);
  return found;
}

/** Taps through the commands, as the UI does, storing each event with a timestamp one second apart. */
class Tablet {
  readonly events: SessionEvent[] = [];
  state: SessionState;

  constructor(
    readonly po: PoQuantities = PO,
    mode: CountingMode = 'ENTERED',
  ) {
    this.state = mode === 'ENTERED' ? EMPTY_SESSION : emptySession(mode);
  }

  private store(payload: SessionEventPayload | null): this {
    if (!payload) throw new Error('Tap not allowed');
    return this.push(payload);
  }

  /** Stores an event without asking a command, like an old log or a damaged one. */
  push(payload: SessionEventPayload): this {
    const seq = this.events.length + 1;
    const at = new Date(Date.UTC(2026, 9, 16, 6, 0, seq)).toISOString();
    const event: SessionEvent = { ...payload, sessionId: 's1', seq, at };
    this.events.push(event);
    this.state = applyEvent(this.state, event);
    return this;
  }

  start(type: InspectionType) {
    return this.store(startInspection(this.state, type, this.po));
  }
  noDefect(times = 1) {
    for (let i = 0; i < times; i++) this.store(noDefect(this.state, this.po));
    return this;
  }
  rework() {
    return this.start('REWORK');
  }
  bGrade() {
    return this.start('B-GRADE');
  }
  defect(defectId: string, areaId?: string) {
    return this.store(recordDefect(this.state, entry(defectId, areaId)));
  }
  end() {
    return this.store(endInspection(this.state));
  }
  undo() {
    return this.store(undo(this.state));
  }
  qty(n: number) {
    return this.store(setQtyInspection(this.state, n, this.po));
  }
  get totals(): SessionTotals {
    return totals(this.state, this.po);
  }
}

/** Qty Inspection, Qty A-Grade, Qty Defect, Qty B-Grade. */
const quantities = (t: SessionTotals) => [t.qtyInspection, t.qtyAGrade, t.qtyDefect, t.qtyBGrade];

describe('ADR-019 counting table', () => {
  // Columns: Qty Inspection, Qty A-Grade, Qty Defect, Qty B-Grade.
  it('Qty Inspection is what the PSI entered; with no finding every pair is A-Grade', () => {
    expect(quantities(new Tablet().qty(40).totals)).toEqual([40, 40, 0, 0]);
  });

  it('starting REWORK or B-GRADE changes no figure (pairs enter no formula)', () => {
    const t = new Tablet().qty(40).rework();
    expect(quantities(t.totals)).toEqual([40, 40, 0, 0]);
    t.end().bGrade();
    expect(quantities(t.totals)).toEqual([40, 40, 0, 0]);
    expect(t.state.counts).toEqual({ rework: 1, bGrade: 1 });
  });

  it('each defect tapped during a REWORK inspection: Qty Defect +1, Qty A-Grade −1', () => {
    const t = new Tablet().qty(40).rework();
    t.defect('D035');
    expect(quantities(t.totals)).toEqual([40, 39, 1, 0]);
  });

  it('each defect tapped during a B-GRADE inspection: Qty Defect +1, Qty B-Grade +1, Qty A-Grade −1', () => {
    const t = new Tablet().qty(40).bGrade();
    t.defect('D035');
    expect(quantities(t.totals)).toEqual([40, 39, 1, 1]);
  });

  describe('regression: Qty Defect counts findings, not defective pairs', () => {
    it('one REWORK pair with three findings adds exactly 3 to Qty Defect', () => {
      const t = new Tablet().qty(10).rework().defect('D035').defect('D005').defect('D035').end();
      expect(t.state.counts.rework).toBe(1);
      expect(t.totals.qtyDefect).toBe(3);
      expect(quantities(t.totals)).toEqual([10, 7, 3, 0]);
    });

    it('one B-GRADE pair with three findings adds exactly 3 to Qty Defect and Qty B-Grade', () => {
      const t = new Tablet().qty(10).bGrade().defect('D035').defect('D005').defect('D049').end();
      expect(t.state.counts.bGrade).toBe(1);
      expect(quantities(t.totals)).toEqual([10, 7, 3, 3]);
    });
  });

  it('ending an inspection without defects changes no figure (AC-06.3)', () => {
    const t = new Tablet().qty(5).rework().end();
    expect(t.state.counts).toEqual({ rework: 1, bGrade: 0 });
    expect(quantities(t.totals)).toEqual([5, 5, 0, 0]);
  });

  it('keeps Qty A-Grade + Qty B-Grade within Qty Inspection, and the rates add to 100%', () => {
    const t = new Tablet().qty(4).bGrade().defect('D035').defect('D035').end();
    const { qtyInspection, qtyAGrade, qtyBGrade, defectRate, passRate } = t.totals;
    expect(qtyAGrade! + qtyBGrade).toBeLessThanOrEqual(qtyInspection!);
    expect(defectRate! + passRate!).toBeCloseTo(1, 10);
  });
});

describe('computeTotals: the doc 02 §9 example (doc 03 §5.5)', () => {
  // Qty Inspection 30; 10 REWORK pairs with 8 findings, 2 B-GRADE pairs with 3 findings.
  const f = (inspectionType: InspectionType, defectId: DefectId, qty: number): Finding => ({
    ...entry(defectId),
    inspectionType,
    qty,
    firstRecordedAt: '2026-10-16T13:05:11+07:00',
  });
  const list = [f('REWORK', 'D035', 5), f('REWORK', 'D049', 3), f('B-GRADE', 'D082', 3)];

  it('from counts and findings, as the API computes it', () => {
    const counts = { rework: 10, bGrade: 2, qtyInspection: 30 };
    const t = computeTotals(counts, list);
    expect(t).toMatchObject({ qtyInspection: 30, qtyAGrade: 19, qtyBGrade: 3, qtyDefect: 11 });
    expect(t.passRate).toBeCloseTo(0.633, 3);
    expect(t.defectRate).toBeCloseTo(0.367, 3);
    expect(t.passRate! + t.defectRate!).toBeCloseTo(1, 10);
    expect(countingRule(counts)).toBe('ADR-019');
  });

  it('from the taps, as the tablet shows it', () => {
    const t = new Tablet().qty(30);
    for (let i = 0; i < 6; i++) t.rework().defect('D035').end();
    t.rework().defect('D035').defect('D049').end();
    for (let i = 0; i < 3; i++) t.rework().end();
    t.bGrade().defect('D082').defect('D005').end();
    t.bGrade().defect('D082').end();
    expect(t.state.counts).toEqual({ rework: 10, bGrade: 2 });
    expect(quantities(t.totals)).toEqual([30, 19, 11, 3]);
    expect(t.totals.passRate).toBeCloseTo(0.633, 3);
    expect(t.totals.defectRate).toBeCloseTo(0.367, 3);
  });

  it('keeps the ADR-008 rules for a payload sealed before the update', () => {
    const counts = { rework: 10, bGrade: 2, noDefect: 18 };
    const t = computeTotals(counts, list);
    expect(t).toMatchObject({ qtyInspection: 30, qtyAGrade: 18, qtyBGrade: 3, qtyDefect: 11 });
    expect(t.passRate).toBeCloseTo(0.6, 3);
    expect(t.defectRate).toBeCloseTo(0.367, 3);
    expect(countingRule(counts)).toBe('ADR-008');
  });

  it('gives null rates for an ADR-008 payload without inspections', () => {
    expect(computeTotals({ rework: 0, bGrade: 0, noDefect: 0 }, [])).toMatchObject({
      defectRate: null,
      passRate: null,
    });
  });
});

describe('rates (BR-02)', () => {
  it('divide by Qty Inspection', () => {
    const t = new Tablet().qty(16).rework().defect('D035').defect('D035').end();
    t.bGrade().defect('D005').end();
    expect(t.totals.defectRate).toBe(3 / 16);
    expect(t.totals.passRate).toBe(13 / 16);
  });

  it('give 0% defects and 100% pass for a session without findings', () => {
    expect(new Tablet().qty(12).totals).toMatchObject({ defectRate: 0, passRate: 1 });
  });
});

describe('Qty Inspection empty or not valid (BR-10, ADR-019 decisions 6 and 7)', () => {
  const invalid = { qtyAGrade: null, defectRate: null, passRate: null };

  it('empty: A-Grade and rates are null, findings still counted', () => {
    const t = new Tablet().bGrade().defect('D035').defect('D005').end();
    expect(t.totals).toEqual({
      qtyInspection: null,
      qtyDefect: 2,
      qtyBGrade: 2,
      ...invalid,
      qtyInspectionIssue: { kind: 'EMPTY' },
    });
    expect(totals(EMPTY_SESSION)).toMatchObject({ qtyInspection: null, qtyDefect: 0, ...invalid });
  });

  it('a finding is still recorded when it takes Qty Defect above Qty Inspection', () => {
    const t = new Tablet().qty(2).rework().defect('D035').defect('D035');
    expect(recordDefect(t.state, entry('D005'))).not.toBeNull();
    t.defect('D005');
    expect(t.state.qtyInspection).toBe(2);
    expect(t.totals).toMatchObject({
      qtyInspection: 2,
      qtyDefect: 3,
      qtyBGrade: 0,
      ...invalid,
      qtyInspectionIssue: { kind: 'BELOW', min: 3 },
    });
  });

  it('becomes valid again when the PSI corrects Qty Inspection', () => {
    const t = new Tablet().qty(2).rework().defect('D035').defect('D035').defect('D005').end();
    t.qty(3);
    expect(t.totals).toMatchObject({
      qtyAGrade: 0,
      defectRate: 1,
      passRate: 0,
      qtyInspectionIssue: null,
    });
  });

  it('becomes valid again when the PSI removes the extra finding with UNDO', () => {
    const t = new Tablet().qty(2).rework().defect('D035').defect('D035').defect('D005');
    t.undo();
    expect(t.totals).toMatchObject({ qtyAGrade: 0, qtyDefect: 2, qtyInspectionIssue: null });
  });

  it('above the partial quantity: not valid, the entered value is kept', () => {
    const po = { orderQty: 100, partial: { number: 1, qty: 60 } };
    const t = new Tablet(po).qty(50);
    const smaller = { ...po, partial: { number: 1, qty: 40 } };
    expect(totals(t.state, smaller)).toMatchObject({
      qtyInspection: 50,
      ...invalid,
      qtyInspectionIssue: { kind: 'ABOVE', max: 40 },
    });
  });

  it('without the PO only the upper limit is left unchecked', () => {
    const t = new Tablet().qty(9_000);
    expect(totals(t.state).qtyInspectionIssue).toBeNull();
    expect(totals(t.state, { orderQty: 100, partial: null }).qtyInspectionIssue).toEqual({
      kind: 'ABOVE',
      max: 100,
    });
  });
});

describe('impossible limits: no Qty Inspection is valid (BR-10)', () => {
  const threeDefects = (po: PoQuantities) =>
    new Tablet(po).rework().defect('D035').defect('D035').defect('D005').end();

  it('Qty Defect above Qty Order', () => {
    const po = { orderQty: 2, partial: null };
    const t = threeDefects(po);
    expect(qtyInspectionLimits(3, null, 2)).toEqual({ min: 3, max: 2 });
    for (const n of [1, 2, 3]) expect(setQtyInspection(t.state, n, po)).toBeNull();
    expect(t.totals).toMatchObject({ qtyDefect: 3, qtyAGrade: null, passRate: null });
    expect(findings(t.state)).toHaveLength(2);
  });

  it('Qty Defect above the partial quantity', () => {
    const po = { orderQty: 100, partial: { number: 2, qty: 2 } };
    const t = threeDefects(po);
    for (const n of [2, 3, 100]) expect(setQtyInspection(t.state, n, po)).toBeNull();
    expect(t.totals.qtyDefect).toBe(3);
  });

  it('any minimum above the maximum, also with a Qty Inspection entered earlier', () => {
    const po = { orderQty: 100, partial: { number: 1, qty: 3 } };
    const t = new Tablet(po).qty(3).rework().defect('D035').defect('D035').defect('D005');
    t.defect('D049');
    expect(t.state.recorded).toHaveLength(4);
    expect(t.totals).toMatchObject({
      qtyInspection: 3,
      qtyDefect: 4,
      qtyAGrade: null,
      defectRate: null,
      passRate: null,
      qtyInspectionIssue: { kind: 'IMPOSSIBLE', min: 4, max: 3 },
    });
  });
});

describe('qtyInspectionLimits and checkQtyInspection (BR-10)', () => {
  it('min is 1 without findings, else Qty Defect; max is the partial quantity, else Qty Order', () => {
    expect(qtyInspectionLimits(0, null, 500)).toEqual({ min: 1, max: 500 });
    expect(qtyInspectionLimits(7, null, 500)).toEqual({ min: 7, max: 500 });
    expect(qtyInspectionLimits(7, { number: 1, qty: 120 }, 500)).toEqual({ min: 7, max: 120 });
  });

  it.each([
    [null, { kind: 'EMPTY' }],
    [0, { kind: 'BELOW', min: 1 }],
    [6, { kind: 'BELOW', min: 7 }],
    [7, null],
    [120, null],
    [121, { kind: 'ABOVE', max: 120 }],
  ] as const)('qty %s', (qty, issue) => {
    const limits = qtyInspectionLimits(qty === 0 ? 0 : 7, { number: 1, qty: 120 }, 500);
    expect(checkQtyInspection(qty, limits)).toEqual(issue);
  });

  it.each([null, 1, 3, 4])('reports impossible limits before inspecting qty %s', (qty) => {
    for (const partial of [null, { number: 1, qty: 3 }]) {
      const limits = qtyInspectionLimits(4, partial, partial ? 100 : 3);
      expect(checkQtyInspection(qty, limits)).toEqual({
        kind: 'IMPOSSIBLE',
        min: 4,
        max: 3,
      });
    }
  });
});

describe('setQtyInspection (FR-15)', () => {
  it('refuses 0, a fraction and values outside the limits', () => {
    const t = new Tablet({ orderQty: 50, partial: null }).rework().defect('D035').defect('D035');
    const po = t.po;
    for (const n of [0, 1, 2.5, 51]) expect(setQtyInspection(t.state, n, po)).toBeNull();
    expect(setQtyInspection(t.state, 2, po)).toEqual({ type: 'SET_QTY_INSPECTION', qty: 2 });
  });

  it('the last value wins', () => {
    expect(new Tablet().qty(40).qty(25).state.qtyInspection).toBe(25);
  });

  it('is allowed during an active inspection and leaves UNDO on the last defect', () => {
    const t = new Tablet().rework().defect('D035').defect('D005').qty(20);
    expect(t.state.active?.type).toBe('REWORK');
    expect(t.state.undo).toBe('DEFECT');
    t.undo();
    expect(t.state.recorded.map((d) => d.defectId)).toEqual(['D035']);
    expect(t.state.qtyInspection).toBe(20);
  });

  it('leaves the UNDO of a just-started inspection in place', () => {
    const t = new Tablet().bGrade().qty(8);
    expect(t.state.undo).toBe('INSPECTION');
    t.undo();
    expect(t.state.active).toBeNull();
    expect(t.state.qtyInspection).toBe(8);
  });

  it('the reducer ignores a stored value that is not a whole number of at least 1', () => {
    const t = new Tablet().qty(10);
    t.push({ type: 'SET_QTY_INSPECTION', qty: 0 }).push({ type: 'SET_QTY_INSPECTION', qty: 3.5 });
    expect(t.state.qtyInspection).toBe(10);
  });
});

describe('one inspection at a time (BR-05, AC-06.1)', () => {
  it('refuses REWORK and B-GRADE while an inspection is active', () => {
    const { state } = new Tablet().rework();
    expect(startInspection(state, 'REWORK')).toBeNull();
    expect(startInspection(state, 'B-GRADE')).toBeNull();
  });

  it('refuses defects and END INSPECTION without an active inspection', () => {
    for (const { state } of [new Tablet(), new Tablet().qty(5), new Tablet().rework().end()]) {
      expect(recordDefect(state, entry('D035'))).toBeNull();
      expect(endInspection(state)).toBeNull();
    }
  });

  it('records the inspection type on each defect', () => {
    const t = new Tablet().bGrade().defect('D035');
    expect(t.state.active?.type).toBe('B-GRADE');
    expect(t.state.recorded.map((d) => d.inspectionType)).toEqual(['B-GRADE']);
  });
});

describe('UNDO (FR-08)', () => {
  it('removes the last defect of the active inspection, one per UNDO', () => {
    const t = new Tablet().qty(10).rework().defect('D035').defect('D005');
    expect(t.state.undo).toBe('DEFECT');
    t.undo();
    expect(t.state.recorded.map((d) => d.defectId)).toEqual(['D035']);
    expect(t.state.undo).toBe('DEFECT');
    t.undo();
    expect(t.state.recorded).toEqual([]);
    expect(t.state.active?.type).toBe('REWORK');
    expect(quantities(t.totals)).toEqual([10, 10, 0, 0]);
  });

  it('reverses Qty B-Grade with the defect', () => {
    const t = new Tablet().qty(10).bGrade().defect('D035').defect('D035').undo();
    expect(quantities(t.totals)).toEqual([10, 9, 1, 1]);
  });

  it('with no defects, cancels the inspection and its pair', () => {
    const t = new Tablet().qty(10).rework().end().bGrade();
    expect(t.state.undo).toBe('INSPECTION');
    t.undo();
    expect(t.state.active).toBeNull();
    expect(t.state.counts).toEqual({ rework: 1, bGrade: 0 });
    expect(t.state.qtyInspection).toBe(10);
  });

  it('removes defects and then the inspection itself', () => {
    const t = new Tablet().rework().defect('D035').undo();
    expect(t.state.undo).toBe('INSPECTION');
    t.undo();
    expect(t.state.counts).toEqual({ rework: 0, bGrade: 0 });
    expect(t.state.recorded).toEqual([]);
  });

  describe('is disabled otherwise and never reaches an ended inspection', () => {
    const cases: [string, () => Tablet][] = [
      ['on an empty session', () => new Tablet()],
      ['after only Qty Inspection was entered', () => new Tablet().qty(10)],
      ['after END INSPECTION without defects', () => new Tablet().rework().end()],
      ['after END INSPECTION with defects', () => new Tablet().bGrade().defect('D035').end()],
      [
        'after END and a Qty Inspection change',
        () => new Tablet().rework().defect('D035').end().qty(9),
      ],
      ['after UNDO cancelled an inspection', () => new Tablet().rework().end().rework().undo()],
    ];
    it.each(cases)('%s', (_, build) => {
      const t = build();
      expect(t.state.undo).toBeNull();
      expect(undo(t.state)).toBeNull();
    });
  });

  it('keeps the counts of an ended inspection when UNDO is attempted', () => {
    const t = new Tablet().bGrade().defect('D035').end();
    const before = t.state;
    const event: SessionEvent = {
      type: 'UNDO',
      sessionId: 's1',
      seq: 99,
      at: '2026-10-16T07:00:00Z',
    };
    expect(applyEvent(before, event)).toBe(before);
  });
});

describe('legacy NO_DEFECT events (ADR-019 decision 9)', () => {
  it('are ignored: no figure, no UNDO state, Qty Inspection still to be entered', () => {
    const t = new Tablet().rework().defect('D035').end();
    const before = t.state;
    t.push({ type: 'NO_DEFECT' }).push({ type: 'NO_DEFECT' });
    expect(t.state).toBe(before);
    expect(t.totals).toMatchObject({ qtyInspection: null, qtyDefect: 1, qtyAGrade: null });
  });

  it('an UNDO after a legacy NO_DEFECT does nothing', () => {
    const t = new Tablet().rework().end().push({ type: 'NO_DEFECT' }).push({ type: 'UNDO' });
    expect(t.state.counts).toEqual({ rework: 1, bGrade: 0 });
    expect(t.state.undo).toBeNull();
  });

  it('a session open during the update replays to the same state with or without them', () => {
    const t = new Tablet().push({ type: 'NO_DEFECT' }).rework().defect('D035').end();
    t.push({ type: 'NO_DEFECT' }).qty(20);
    const without = t.events.filter((e) => e.type !== 'NO_DEFECT');
    expect(replay(t.events)).toEqual(replay(without));
    expect(quantities(totals(replay(t.events), PO))).toEqual([20, 19, 1, 0]);
  });
});

describe('PSI lv.2 counts Qty Inspection with taps (ADR-021)', () => {
  const lv2 = (po: PoQuantities = PO) => new Tablet(po, 'TAPPED');

  it('PSI lv.1 enters Qty Inspection, PSI lv.2 taps it', () => {
    expect(countingMode('PSI lv.1')).toBe('ENTERED');
    expect(countingMode('PSI lv.2')).toBe('TAPPED');
  });

  // Columns: Qty Inspection, Qty A-Grade, Qty Defect, Qty B-Grade.
  it('NO DEFECT: Qty Inspection +1, Qty A-Grade +1', () => {
    expect(quantities(lv2().noDefect().totals)).toEqual([1, 1, 0, 0]);
    expect(quantities(lv2().noDefect(3).totals)).toEqual([3, 3, 0, 0]);
  });

  it('a REWORK or B-GRADE pair is counted at END INSPECTION', () => {
    const t = lv2().rework();
    expect(quantities(t.totals)).toEqual([0, 0, 0, 0]);
    t.defect('D035');
    expect(quantities(t.totals)).toEqual([0, 0, 1, 0]);
    t.end();
    expect(quantities(t.totals)).toEqual([1, 0, 1, 0]);
    t.bGrade().end();
    expect(quantities(t.totals)).toEqual([2, 0, 1, 0]);
  });

  it('each defect: Qty Defect +1; in B-GRADE also Qty B-Grade +1 (three findings add 3)', () => {
    const t = lv2().bGrade().defect('D035').defect('D005').defect('D001').end();
    expect(quantities(t.totals)).toEqual([1, 0, 3, 3]);
    t.rework().defect('D035').end();
    expect(quantities(t.totals)).toEqual([2, 0, 4, 3]);
  });

  it('Defect Rate = Qty Defect ÷ Qty Inspection, Pass Rate = NO DEFECT ÷ Qty Inspection', () => {
    const t = lv2().noDefect(8).rework().defect('D035').defect('D005').end().bGrade().end();
    expect(t.totals).toMatchObject({
      qtyInspection: 10,
      qtyAGrade: 8,
      qtyDefect: 2,
      qtyBGrade: 0,
      defectRate: 0.2,
      passRate: 0.8,
      qtyInspectionIssue: null,
    });
  });

  it('rates are null until the first pair is counted (screens show 0,0%)', () => {
    expect(lv2().totals).toMatchObject({ qtyInspection: 0, qtyAGrade: 0, defectRate: null });
    expect(lv2().rework().defect('D035').totals).toMatchObject({
      qtyInspection: 0,
      defectRate: null,
      passRate: null,
    });
  });

  it('submits ADR-008 counts that give the same totals on the API', () => {
    const t = lv2().noDefect(5).rework().defect('D035').end().bGrade().defect('D005').end();
    const counts = { ...t.state.counts, noDefect: t.state.noDefect };
    expect(countingRule(counts)).toBe('ADR-008');
    const api = computeTotals(counts, findings(t.state));
    const shown = t.totals;
    expect([api.qtyInspection, api.qtyAGrade, api.qtyDefect, api.qtyBGrade]).toEqual(
      quantities(shown),
    );
    expect([api.defectRate, api.passRate]).toEqual([shown.defectRate, shown.passRate]);
  });

  describe('NO DEFECT', () => {
    it('is refused during an inspection and in a PSI lv.1 session', () => {
      expect(noDefect(lv2().rework().state, PO)).toBeNull();
      expect(noDefect(new Tablet().state, PO)).toBeNull();
    });

    it('UNDO right after it removes that pair; then UNDO is disabled', () => {
      const t = lv2().noDefect(2);
      expect(t.state.undo).toBe('NO_DEFECT');
      t.undo();
      expect(quantities(t.totals)).toEqual([1, 1, 0, 0]);
      expect(t.state.undo).toBeNull();
      expect(undo(t.state)).toBeNull();
    });

    it('UNDO never reaches a NO DEFECT before an inspection', () => {
      const t = lv2().noDefect().rework().undo();
      expect(t.state.undo).toBeNull();
      expect(quantities(t.totals)).toEqual([1, 1, 0, 0]);
    });
  });

  describe('maximum: the partial quantity, else Qty Order (ADR-021)', () => {
    const small: PoQuantities = { orderQty: 3, partial: null };

    it('refuses NO DEFECT, REWORK and B-GRADE at the maximum, never a defect', () => {
      const t = lv2(small).noDefect(2).rework();
      // The active inspection is the third pair: no new pair, but its defects are still recorded.
      expect(canAddPair(t.state, small)).toBe(false);
      t.defect('D035').defect('D005').end();
      expect(t.totals.qtyInspection).toBe(3);
      expect(t.totals.qtyDefect).toBe(2);
      expect(noDefect(t.state, small)).toBeNull();
      expect(startInspection(t.state, 'REWORK', small)).toBeNull();
      expect(startInspection(t.state, 'B-GRADE', small)).toBeNull();
      expect(t.totals.qtyInspectionIssue).toBeNull();
    });

    it('uses the partial quantity when set', () => {
      const partial: PoQuantities = { orderQty: 100, partial: { number: 1, qty: 2 } };
      const t = lv2(partial).noDefect(2);
      expect(noDefect(t.state, partial)).toBeNull();
    });

    it('an UNDO frees the pair again', () => {
      const t = lv2(small).noDefect(3).undo();
      expect(noDefect(t.state, small)).not.toBeNull();
    });

    it('flags pairs above a maximum lowered afterwards (ABOVE)', () => {
      const t = lv2().noDefect(5);
      expect(totals(t.state, { orderQty: 100, partial: { number: 1, qty: 4 } })).toMatchObject({
        qtyInspection: 5,
        qtyInspectionIssue: { kind: 'ABOVE', max: 4 },
      });
    });

    it('ENTERED sessions are never limited by taps', () => {
      expect(
        canAddPair(new Tablet(small).rework().end().rework().end().rework().end().state, small),
      ).toBe(true);
    });
  });

  describe('events of the other mode', () => {
    it('TAPPED ignores an entered Qty Inspection; ENTERED ignores NO DEFECT taps', () => {
      const events = new Tablet().qty(40).push({ type: 'NO_DEFECT' }).events;
      expect(replay(events, 'TAPPED')).toMatchObject({ qtyInspection: null, noDefect: 1 });
      expect(replay(events, 'ENTERED')).toMatchObject({ qtyInspection: 40, noDefect: 0 });
      expect(replay(events)).toEqual(replay(events, 'ENTERED'));
    });

    it('setQtyInspection is refused in TAPPED', () => {
      expect(setQtyInspection(lv2().state, 5, PO)).toBeNull();
    });
  });

  it('replays to the same state', () => {
    const t = lv2()
      .noDefect(2)
      .rework()
      .defect('D035')
      .undo()
      .defect('D005')
      .end()
      .noDefect()
      .undo();
    expect(replay(t.events, 'TAPPED')).toEqual(t.state);
  });
});

describe('reducer', () => {
  it('rebuilds the same state from the stored events', () => {
    const t = new Tablet()
      .qty(30)
      .rework()
      .defect('D035')
      .defect('D005')
      .undo()
      .end()
      .bGrade()
      .defect('D082')
      .qty(25);
    expect(replay(t.events)).toEqual(t.state);
  });

  it('ignores events the state does not allow', () => {
    const base = { sessionId: 's1', at: '2026-10-16T07:00:00Z' };
    const events: SessionEvent[] = [
      { ...base, seq: 1, type: 'END' },
      { ...base, seq: 2, type: 'DEFECT', ...entry('D035') },
      { ...base, seq: 3, type: 'START_REWORK' },
      { ...base, seq: 4, type: 'START_BGRADE' },
      { ...base, seq: 5, type: 'NO_DEFECT' },
      { ...base, seq: 6, type: 'SET_QTY_INSPECTION', qty: -1 },
    ];
    const state = replay(events);
    expect(state.counts).toEqual({ rework: 1, bGrade: 0 });
    expect(state.qtyInspection).toBeNull();
    expect(state.recorded).toEqual([]);
    expect(state.active?.type).toBe('REWORK');
  });
});

describe('findings', () => {
  it('groups by inspection type, area, sub-area and defect, with the first tap time', () => {
    const t = new Tablet()
      .rework()
      .defect('D035', 'A01')
      .defect('D035', 'A01')
      .defect('D035', 'A02')
      .end()
      .bGrade()
      .defect('D035', 'A01')
      .end();
    const list = findings(t.state);
    expect(list.map((f) => [f.inspectionType, f.areaId, f.defectId, f.qty])).toEqual([
      ['REWORK', 'A01', 'D035', 2],
      ['REWORK', 'A02', 'D035', 1],
      ['B-GRADE', 'A01', 'D035', 1],
    ]);
    expect(list[0]?.firstRecordedAt).toBe(t.events[1]?.at);
  });

  it('keeps D049 and D071 apart although they share a name (ADR-009)', () => {
    const t = new Tablet().rework().defect('D049').defect('D071');
    expect(findings(t.state).map((f) => f.defectId)).toEqual(['D049', 'D071']);
  });
});

describe('Top 5 (FR-05, AC-05.1, doc 02 §6.2)', () => {
  const classification = (id: string) => mapping.defect(id)!.classification;
  const ids = (state: SessionState) => top5(findings(state), mapping).map((d) => d.defectId);
  const majors = mapping.defects.filter((d) => d.classification === 'MAJOR').map((d) => d.id);

  it('uses defects of each severity (fixture check)', () => {
    expect(['D005', 'D035', 'D049'].map(classification)).toEqual(['CRITICAL', 'MAJOR', 'MINOR']);
  });

  it('is empty without defects', () => {
    expect(top5(findings(new Tablet().qty(5).rework().end().state), mapping)).toEqual([]);
  });

  it('orders by total quantity first', () => {
    const t = new Tablet().rework().defect('D005').defect('D049').defect('D049');
    expect(ids(t.state)).toEqual(['D049', 'D005']);
  });

  it('breaks ties by severity: CRITICAL > MAJOR > MINOR', () => {
    const t = new Tablet().rework().defect('D049').defect('D035').defect('D005');
    expect(ids(t.state)).toEqual(['D005', 'D035', 'D049']);
  });

  it('then by the defect recorded first', () => {
    const [a, b] = [majors[3]!, majors[0]!];
    const t = new Tablet().rework().defect(b).defect(a).defect(a).defect(b);
    expect(ids(t.state)).toEqual([b, a]);
  });

  it('sums quantities across areas and inspection types and lists the areas', () => {
    const t = new Tablet()
      .rework()
      .defect('D005')
      .defect('D035', 'A02')
      .end()
      .bGrade()
      .defect('D035', 'A01')
      .end();
    const [first] = top5(findings(t.state), mapping);
    expect(first).toMatchObject({ defectId: 'D035', qty: 2, areaIds: ['A02', 'A01'] });
    expect(first?.firstRecordedAt).toBe(t.events[2]?.at);
  });

  it('returns only five', () => {
    const t = new Tablet().rework();
    for (const id of majors.slice(0, 7)) t.defect(id);
    expect(ids(t.state)).toEqual(majors.slice(0, 5));
  });

  it('ranks by first-recorded time, not by the order of the findings list', () => {
    const f = (defectId: DefectId, at: string): Finding => ({
      ...entry(defectId),
      inspectionType: 'REWORK',
      qty: 1,
      firstRecordedAt: at,
    });
    const list = [f('D049', '2026-10-16T13:00:02+07:00'), f('D071', '2026-10-16T13:00:01+07:00')];
    expect(rankDefects(list, classification).map((d) => d.defectId)).toEqual(['D071', 'D049']);
  });
});
