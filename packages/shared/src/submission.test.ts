import { describe, expect, it } from 'vitest';
import {
  findings,
  replay,
  top5,
  type PoQuantities,
  type SessionEventPayload,
  type SessionState,
} from './counting';
import type { AreaMapEntry, Defect, DefectId, PsiLevel, SessionEvent } from './domain';
import { defaultMapping } from './mapping';
import { buildSubmission, checkSubmit, submissionPhotos, type SubmissionInput } from './submission';

const mapping = defaultMapping();

function entry(defectId: string): AreaMapEntry {
  const found = mapping.map.find((e) => e.defectId === defectId);
  if (!found) throw new Error(`No map entry for ${defectId}`);
  return found;
}

const REWORK: SessionEventPayload = { type: 'START_REWORK' };
const BGRADE: SessionEventPayload = { type: 'START_BGRADE' };
const QTY = (qty: number): SessionEventPayload => ({ type: 'SET_QTY_INSPECTION', qty });
const END: SessionEventPayload = { type: 'END' };
const UNDO: SessionEventPayload = { type: 'UNDO' };
const defect = (id: string): SessionEventPayload => ({ type: 'DEFECT', ...entry(id) });

/** Stored taps, one second apart from 13:00:01.250 WIB. */
function events(payloads: SessionEventPayload[]): SessionEvent[] {
  return payloads.map((p, i): SessionEvent => ({
    ...p,
    sessionId: 's1',
    seq: i + 1,
    at: new Date(Date.UTC(2026, 9, 16, 6, 0, i + 1, 250)).toISOString(),
  }));
}

/** A PSI lv.1 session (`ENTERED`) from its taps. */
function session(...payloads: SessionEventPayload[]): SessionState {
  return replay(events(payloads));
}

/** A PSI lv.2 session (`TAPPED`, ADR-021) from its taps. */
function tapped(...payloads: SessionEventPayload[]): SessionState {
  return replay(events(payloads), 'TAPPED');
}

function check(state: SessionState, level: PsiLevel, photographed: DefectId[] = []) {
  return checkSubmit({
    po: { partial: null, orderQty: 10002 },
    state,
    level,
    top: top5(findings(state), mapping),
    photographed: new Set(photographed),
  });
}

describe('checkSubmit (FR-11.1, doc 05 §13.1)', () => {
  it('stops while an inspection is active, before any other check', () => {
    expect(check(session(REWORK), 'PSI lv.2')).toEqual({ kind: 'ACTIVE' });
    expect(check(session(QTY(5), BGRADE, defect('D035')), 'PSI lv.2')).toEqual({
      kind: 'ACTIVE',
    });
  });

  it('stops while Qty Inspection is not entered (FR-15), also with findings recorded', () => {
    expect(check(session(), 'PSI lv.1')).toEqual({ kind: 'EMPTY' });
    expect(check(session(REWORK, defect('D035'), END), 'PSI lv.1')).toEqual({ kind: 'EMPTY' });
    expect(check(session(REWORK, defect('D035'), END), 'PSI lv.2')).toEqual({ kind: 'EMPTY' });
  });

  it('ignores a legacy NO_DEFECT: it does not count as an inspection', () => {
    expect(check(session({ type: 'NO_DEFECT' }), 'PSI lv.1')).toEqual({ kind: 'EMPTY' });
  });

  it('lists the Top 5 defects without a photo for PSI lv.2, in rank order (BR-04)', () => {
    const state = session(QTY(10), REWORK, defect('D035'), defect('D082'), defect('D082'), END);
    const block = check(state, 'PSI lv.2', ['D082']);
    expect(block?.kind).toBe('PHOTOS_MISSING');
    expect(block?.kind === 'PHOTOS_MISSING' && block.defects.map((d) => d.defectId)).toEqual([
      'D035',
    ]);
    expect(check(state, 'PSI lv.2', ['D035', 'D082'])).toBeNull();
  });

  it('never asks PSI lv.1 for photos (AC-10.6)', () => {
    expect(check(session(QTY(10), REWORK, defect('D035'), END), 'PSI lv.1')).toBeNull();
  });

  it('lets an inspected session without defects through', () => {
    expect(check(session(QTY(12)), 'PSI lv.2')).toBeNull();
  });
});

describe('checkSubmit: Qty Inspection priority (BR-10, IMPOSSIBLE before EMPTY)', () => {
  const blockFor = (state: SessionState, po: PoQuantities) =>
    checkSubmit({ po, state, level: 'PSI lv.1', top: [], photographed: new Set() });
  const threeFindings = [REWORK, defect('D035'), defect('D035'), defect('D005'), END];
  const smallOrder: PoQuantities = { orderQty: 2, partial: null };
  const smallPartial: PoQuantities = { orderQty: 100, partial: { number: 1, qty: 2 } };
  const roomy: PoQuantities = { orderQty: 100, partial: { number: 1, qty: 40 } };

  it('empty Qty Inspection with impossible PO limits → IMPOSSIBLE', () => {
    expect(blockFor(session(...threeFindings), smallOrder)).toEqual({
      kind: 'IMPOSSIBLE',
      min: 3,
      max: 2,
    });
  });

  it('empty Qty Inspection with impossible partial limits → IMPOSSIBLE', () => {
    expect(blockFor(session(...threeFindings), smallPartial)).toEqual({
      kind: 'IMPOSSIBLE',
      min: 3,
      max: 2,
    });
  });

  it('entered Qty Inspection with impossible limits → IMPOSSIBLE', () => {
    for (const qty of [1, 2]) {
      expect(blockFor(session(QTY(qty), ...threeFindings), smallOrder)).toEqual({
        kind: 'IMPOSSIBLE',
        min: 3,
        max: 2,
      });
      expect(blockFor(session(QTY(qty), ...threeFindings), smallPartial)?.kind).toBe('IMPOSSIBLE');
    }
  });

  it('empty Qty Inspection with feasible limits → EMPTY', () => {
    expect(blockFor(session(...threeFindings), roomy)).toEqual({ kind: 'EMPTY' });
    expect(blockFor(session(), roomy)).toEqual({ kind: 'EMPTY' });
  });

  it('feasible limits: BELOW under Qty Defect, ABOVE over the partial, null within', () => {
    expect(blockFor(session(QTY(2), ...threeFindings), roomy)).toEqual({ kind: 'BELOW', min: 3 });
    expect(blockFor(session(QTY(41), ...threeFindings), roomy)).toEqual({
      kind: 'ABOVE',
      max: 40,
    });
    expect(
      blockFor(session(QTY(41), ...threeFindings), { orderQty: 100, partial: null }),
    ).toBeNull();
    expect(blockFor(session(QTY(3), ...threeFindings), roomy)).toBeNull();
    expect(blockFor(session(QTY(40), ...threeFindings), roomy)).toBeNull();
  });

  it('an active inspection still comes first', () => {
    expect(
      blockFor(session(REWORK, defect('D035'), defect('D035'), defect('D005')), smallOrder),
    ).toEqual({ kind: 'ACTIVE' });
  });

  it('blocks without touching the findings, and the session can not be built', () => {
    const state = session(QTY(2), ...threeFindings);
    const before = findings(state);
    expect(blockFor(state, smallOrder)?.kind).toBe('IMPOSSIBLE');
    expect(findings(state)).toEqual(before);
    expect(before.map((f) => [f.defectId, f.qty])).toEqual([
      ['D035', 2],
      ['D005', 1],
    ]);
    expect(blockFor(session(...threeFindings), smallOrder)).not.toBeNull();
    expect(() => buildSubmission(input(session(...threeFindings)))).toThrow();
  });
});

function input(state: SessionState, overrides: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    submissionUuid: '0f6b6c1e-6a52-4c9f-9a3e-5d7a2b0c41f2',
    sealedAt: '2026-10-16T07:32:05.000Z',
    appVersion: '1.0.0',
    user: { username: 'AZIZAH', level: 'PSI lv.2' },
    cell: { factory: 'F 3', cell: 'F3-10' },
    po: '0903359388',
    partial: { number: 1, qty: 1200 },
    state,
    photos: [],
    ...overrides,
  };
}

describe('buildSubmission (doc 04 §4.1)', () => {
  const state = session(
    REWORK,
    defect('D035'),
    defect('D035'),
    END,
    BGRADE,
    defect('D082'),
    END,
    QTY(30),
  );

  it('sends what happened, not totals, with times in WIB', () => {
    const photos = [
      { defectId: 'D082' as const, sha256: 'b'.repeat(64) },
      { defectId: 'D035' as const, sha256: 'a'.repeat(64) },
    ];
    const r035 = entry('D035');
    const r082 = entry('D082');
    expect(buildSubmission(input(state, { photos }))).toEqual({
      submissionUuid: '0f6b6c1e-6a52-4c9f-9a3e-5d7a2b0c41f2',
      sealedAt: '2026-10-16T14:32:05.000+07:00',
      appVersion: '1.0.0',
      user: { username: 'AZIZAH', level: 'PSI lv.2' },
      factory: 'F 3',
      cell: 'F3-10',
      po: '0903359388',
      partial: { number: 1, qty: 1200 },
      counts: { rework: 1, bGrade: 1, qtyInspection: 30 },
      findings: [
        {
          inspectionType: 'REWORK',
          ...r035,
          qty: 2,
          firstRecordedAt: '2026-10-16T13:00:02.250+07:00',
        },
        {
          inspectionType: 'B-GRADE',
          ...r082,
          qty: 1,
          firstRecordedAt: '2026-10-16T13:00:06.250+07:00',
        },
      ],
      photos: [
        { defectId: 'D035', part: 'photo_D035', sha256: 'a'.repeat(64) },
        { defectId: 'D082', part: 'photo_D082', sha256: 'b'.repeat(64) },
      ],
    });
  });

  it('can not be built without Qty Inspection (checkSubmit stops it first)', () => {
    const without = session(REWORK, defect('D035'), END);
    expect(() => buildSubmission(input(without))).toThrow('Qty Inspection is not entered');
  });

  it('sends a null partial when the PO is not partial', () => {
    expect(buildSubmission(input(state, { partial: null })).partial).toBeNull();
  });

  it('sends no photos for PSI lv.1, whatever is stored (AC-10.6)', () => {
    const photos = [{ defectId: 'D035' as const, sha256: 'a'.repeat(64) }];
    const built = buildSubmission(
      input(state, { user: { username: 'EVA', level: 'PSI lv.1' }, photos }),
    );
    expect(built.photos).toEqual([]);
  });

  it('serialises to the same string every time', () => {
    expect(JSON.stringify(buildSubmission(input(state)))).toBe(
      JSON.stringify(buildSubmission(input(state))),
    );
  });
});

describe('PSI lv.2 with tapped counts (ADR-021)', () => {
  const NO_DEFECT: SessionEventPayload = { type: 'NO_DEFECT' };
  const po = (orderQty: number, partialQty?: number): PoQuantities => ({
    orderQty,
    partial: partialQty === undefined ? null : { number: 1, qty: partialQty },
  });
  const blockFor = (state: SessionState, quantities: PoQuantities = po(10002)) =>
    checkSubmit({ po: quantities, state, level: 'PSI lv.2', top: [], photographed: new Set() });

  it('stops while no pair is counted, also with a defect in an active inspection', () => {
    expect(blockFor(tapped())).toEqual({ kind: 'NO_PAIRS' });
    expect(blockFor(tapped(REWORK, defect('D035')))).toEqual({ kind: 'ACTIVE' });
  });

  it('needs no entered Qty Inspection: NO DEFECT or an ended inspection is enough', () => {
    expect(blockFor(tapped(NO_DEFECT))).toBeNull();
    expect(blockFor(tapped(REWORK, END))).toBeNull();
  });

  it('stops above a partial quantity lowered after the taps', () => {
    expect(blockFor(tapped(NO_DEFECT, NO_DEFECT, NO_DEFECT), po(100, 2))).toEqual({
      kind: 'ABOVE',
      max: 2,
    });
  });

  it('still asks for every Top 5 photo (BR-04)', () => {
    const state = tapped(REWORK, defect('D035'), END);
    expect(check(state, 'PSI lv.2')?.kind).toBe('PHOTOS_MISSING');
    expect(check(state, 'PSI lv.2', ['D035'])).toBeNull();
  });

  it('sends the NO DEFECT taps, not a Qty Inspection (ADR-008 calculation on the API)', () => {
    const state = tapped(NO_DEFECT, NO_DEFECT, REWORK, defect('D035'), END, BGRADE, END, QTY(40));
    expect(buildSubmission(input(state)).counts).toEqual({ rework: 1, bGrade: 1, noDefect: 2 });
  });
});

describe('top5 on the API equals top5 on the tablet (doc 03 §5.5)', () => {
  const [majorA, majorB] = mapping.defects
    .filter((d) => d.classification === 'MAJOR' && d.id !== 'D035')
    .map((d) => d.id);

  it('ranks the received findings exactly as Home ranked the session', () => {
    // Three defects tie on quantity 2 (severity decides), the rest tie on 1 (first recorded decides);
    // D035 is split over REWORK and B-GRADE.
    const state = session(
      REWORK,
      defect(majorB!),
      defect('D049'),
      defect('D035'),
      defect('D049'),
      END,
      BGRADE,
      defect(majorA!),
      defect('D035'),
      defect('D005'),
      defect('D005'),
      defect('D020'),
      END,
      QTY(50),
    );
    const onTablet = top5(findings(state), mapping);

    // What the API parses from the `submission` part, ranked with its own defect rows.
    const received = JSON.parse(JSON.stringify(buildSubmission(input(state)))) as ReturnType<
      typeof buildSubmission
    >;
    const rows = new Map<string, Defect>(mapping.defects.map((d) => [d.id, d]));
    const onApi = top5(received.findings, { defect: (id) => rows.get(id) });

    expect(onTablet.map((d) => d.defectId).slice(0, 4)).toEqual(['D005', 'D035', 'D049', majorB]);
    expect(
      onApi.map(({ defectId, qty, classification, areaIds }) => ({
        defectId,
        qty,
        classification,
        areaIds,
      })),
    ).toEqual(
      onTablet.map(({ defectId, qty, classification, areaIds }) => ({
        defectId,
        qty,
        classification,
        areaIds,
      })),
    );
    expect(onApi.map((d) => Date.parse(d.firstRecordedAt))).toEqual(
      onTablet.map((d) => Date.parse(d.firstRecordedAt)),
    );
  });
});

describe('submissionPhotos (AC-10.4, doc 02 §7)', () => {
  it('keeps the photo of a defect that left the Top 5', () => {
    // Six defects ranked by quantity: D001 drops to rank 6 but keeps its photo.
    const ids = ['D035', 'D082', 'D010', 'D020', 'D030'];
    const taps = ids.flatMap((id) => [defect(id), defect(id)]);
    const state = session(REWORK, defect('D001'), ...taps, END);
    expect(top5(findings(state), mapping).map((d) => d.defectId)).not.toContain('D001');
    const kept = submissionPhotos(state, 'PSI lv.2', [{ defectId: 'D001', sha256: 'x' }]);
    expect(kept.map((p) => p.defectId)).toEqual(['D001']);
  });

  it('leaves out the photo of a defect that was undone completely', () => {
    const state = session(REWORK, defect('D035'), defect('D082'), UNDO, END);
    const photos = [
      { defectId: 'D035' as const, sha256: 'a' },
      { defectId: 'D082' as const, sha256: 'b' },
    ];
    expect(submissionPhotos(state, 'PSI lv.2', photos).map((p) => p.defectId)).toEqual(['D035']);
  });
});
