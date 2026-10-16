import { describe, expect, it } from 'vitest';
import {
  EMPTY_SESSION,
  applyEvent,
  endInspection,
  findings,
  noDefect,
  rankDefects,
  recordDefect,
  replay,
  startInspection,
  top5,
  totals,
  undo,
  type SessionEventPayload,
  type SessionState,
  type Totals,
} from './counting';
import type { AreaMapEntry, DefectId, Finding, InspectionType, SessionEvent } from './domain';
import { defaultMapping } from './mapping';

const mapping = defaultMapping();

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
  state: SessionState = EMPTY_SESSION;

  private store(payload: SessionEventPayload | null): this {
    if (!payload) throw new Error('Tap not allowed');
    const seq = this.events.length + 1;
    const at = new Date(Date.UTC(2026, 9, 16, 6, 0, seq)).toISOString();
    const event: SessionEvent = { ...payload, sessionId: 's1', seq, at };
    this.events.push(event);
    this.state = applyEvent(this.state, event);
    return this;
  }

  start(type: InspectionType) {
    return this.store(startInspection(this.state, type));
  }
  rework() {
    return this.start('REWORK');
  }
  bGrade() {
    return this.start('B-GRADE');
  }
  noDefect() {
    return this.store(noDefect(this.state));
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
  get totals(): Totals {
    return totals(this.state);
  }
}

const quantities = (t: Totals) => [t.qtyInspection, t.qtyAGrade, t.qtyDefect, t.qtyBGrade];

describe('ADR-008 counting table', () => {
  // Columns: Qty Inspection, Qty A-Grade, Qty Defect, Qty B-Grade.
  it('Tap REWORK (start): Qty Inspection +1', () => {
    expect(quantities(new Tablet().rework().totals)).toEqual([1, 0, 0, 0]);
  });

  it('Tap B-GRADE (start): Qty Inspection +1', () => {
    expect(quantities(new Tablet().bGrade().totals)).toEqual([1, 0, 0, 0]);
  });

  it('Tap NO DEFECT: Qty Inspection +1, Qty A-Grade +1', () => {
    expect(quantities(new Tablet().noDefect().totals)).toEqual([1, 1, 0, 0]);
  });

  it('Each defect tapped during a Rework inspection: Qty Defect +1', () => {
    const t = new Tablet().rework();
    const before = quantities(t.totals);
    t.defect('D035');
    expect(quantities(t.totals)).toEqual([before[0], before[1], before[2]! + 1, before[3]]);
  });

  it('Each defect tapped during a B-Grade inspection: Qty Defect +1, Qty B-Grade +1', () => {
    const t = new Tablet().bGrade();
    const before = quantities(t.totals);
    t.defect('D035');
    expect(quantities(t.totals)).toEqual([before[0], before[1], before[2]! + 1, before[3]! + 1]);
  });

  it('counts B-Grade per finding: a B-GRADE pair with two defects adds 2 to Qty B-Grade', () => {
    const t = new Tablet().bGrade().defect('D035').defect('D005').end();
    expect(quantities(t.totals)).toEqual([1, 0, 2, 2]);
  });

  it('lets Qty A-Grade + Qty B-Grade exceed Qty Inspection', () => {
    const t = new Tablet().noDefect().bGrade().defect('D035').defect('D035').end();
    const { qtyInspection, qtyAGrade, qtyBGrade } = t.totals;
    expect(qtyAGrade + qtyBGrade).toBeGreaterThan(qtyInspection);
  });

  it('ending an inspection without defects still counts one inspection (AC-06.3)', () => {
    expect(quantities(new Tablet().rework().end().totals)).toEqual([1, 0, 0, 0]);
  });

  it('adds up a mixed session like the doc 04 §4.1 example (10 REWORK, 2 B-GRADE, 18 NO DEFECT)', () => {
    const t = new Tablet();
    for (let i = 0; i < 10; i++) t.rework().defect('D035').end();
    for (let i = 0; i < 2; i++) t.bGrade().defect('D082').end();
    for (let i = 0; i < 18; i++) t.noDefect();
    expect(t.state.counts).toEqual({ rework: 10, bGrade: 2, noDefect: 18 });
    expect(quantities(t.totals)).toEqual([30, 18, 12, 2]);
  });
});

describe('rates (BR-02)', () => {
  it('are null when Qty Inspection is 0', () => {
    expect(totals(EMPTY_SESSION)).toMatchObject({ defectRate: null, passRate: null });
  });

  it('divide by Qty Inspection', () => {
    const t = new Tablet();
    for (let i = 0; i < 13; i++) t.noDefect();
    t.rework().defect('D035').defect('D035').end().rework().end().bGrade().defect('D005').end();
    expect(t.totals.qtyInspection).toBe(16);
    expect(t.totals.defectRate).toBe(3 / 16);
    expect(t.totals.passRate).toBe(13 / 16);
  });

  it('let Defect Rate exceed 100%', () => {
    const t = new Tablet().rework().defect('D035').defect('D035').defect('D005');
    expect(t.totals.defectRate).toBe(3);
  });
});

describe('one inspection at a time (BR-05, AC-06.1)', () => {
  it('refuses REWORK, B-GRADE and NO DEFECT while an inspection is active', () => {
    const { state } = new Tablet().rework();
    expect(startInspection(state, 'REWORK')).toBeNull();
    expect(startInspection(state, 'B-GRADE')).toBeNull();
    expect(noDefect(state)).toBeNull();
  });

  it('refuses defects and END INSPECTION without an active inspection', () => {
    for (const { state } of [new Tablet(), new Tablet().noDefect(), new Tablet().rework().end()]) {
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
    const t = new Tablet().rework().defect('D035').defect('D005');
    expect(t.state.undo).toBe('DEFECT');
    t.undo();
    expect(t.state.recorded.map((d) => d.defectId)).toEqual(['D035']);
    expect(t.state.undo).toBe('DEFECT');
    t.undo();
    expect(t.state.recorded).toEqual([]);
    expect(t.state.active?.type).toBe('REWORK');
    expect(quantities(t.totals)).toEqual([1, 0, 0, 0]);
  });

  it('reverses Qty B-Grade with the defect', () => {
    const t = new Tablet().bGrade().defect('D035').defect('D035').undo();
    expect(quantities(t.totals)).toEqual([1, 0, 1, 1]);
  });

  it('with no defects, cancels the inspection and reverses its +1 Qty Inspection', () => {
    const t = new Tablet().noDefect().bGrade();
    expect(t.state.undo).toBe('INSPECTION');
    t.undo();
    expect(t.state.active).toBeNull();
    expect(t.state.counts).toEqual({ rework: 0, bGrade: 0, noDefect: 1 });
    expect(quantities(t.totals)).toEqual([1, 1, 0, 0]);
  });

  it('removes defects and then the inspection itself', () => {
    const t = new Tablet().rework().defect('D035').undo();
    expect(t.state.undo).toBe('INSPECTION');
    t.undo();
    expect(quantities(t.totals)).toEqual([0, 0, 0, 0]);
  });

  it('right after NO DEFECT, cancels it (reverses +1 Qty Inspection and +1 Qty A-Grade)', () => {
    const t = new Tablet().rework().end().noDefect();
    expect(t.state.undo).toBe('NO_DEFECT');
    t.undo();
    expect(quantities(t.totals)).toEqual([1, 0, 0, 0]);
  });

  describe('is disabled otherwise and never reaches an ended inspection', () => {
    const cases: [string, () => Tablet][] = [
      ['on an empty session', () => new Tablet()],
      ['after END INSPECTION without defects', () => new Tablet().rework().end()],
      ['after END INSPECTION with defects', () => new Tablet().bGrade().defect('D035').end()],
      ['after UNDO cancelled an inspection', () => new Tablet().noDefect().rework().undo()],
      ['after UNDO cancelled a NO DEFECT', () => new Tablet().noDefect().noDefect().undo()],
      [
        'after a NO DEFECT followed by an inspection',
        () => new Tablet().noDefect().rework().defect('D035').undo().undo(),
      ],
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

describe('reducer', () => {
  it('rebuilds the same state from the stored events', () => {
    const t = new Tablet()
      .noDefect()
      .rework()
      .defect('D035')
      .defect('D005')
      .undo()
      .end()
      .bGrade()
      .defect('D082');
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
    ];
    const state = replay(events);
    expect(state.counts).toEqual({ rework: 1, bGrade: 0, noDefect: 0 });
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
  const ids = (state: SessionState) => top5(state, mapping).map((d) => d.defectId);
  const majors = mapping.defects.filter((d) => d.classification === 'MAJOR').map((d) => d.id);

  it('uses defects of each severity (fixture check)', () => {
    expect(['D005', 'D035', 'D049'].map(classification)).toEqual(['CRITICAL', 'MAJOR', 'MINOR']);
  });

  it('is empty without defects', () => {
    expect(top5(new Tablet().noDefect().rework().end().state, mapping)).toEqual([]);
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
    const [first] = top5(t.state, mapping);
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
