import { describe, expect, it } from 'vitest';
import { replay, top5, type SessionEventPayload, type SessionState } from './counting';
import type { AreaMapEntry, DefectId, PsiLevel, SessionEvent } from './domain';
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
const NO_DEFECT: SessionEventPayload = { type: 'NO_DEFECT' };
const END: SessionEventPayload = { type: 'END' };
const UNDO: SessionEventPayload = { type: 'UNDO' };
const defect = (id: string): SessionEventPayload => ({ type: 'DEFECT', ...entry(id) });

/** A session from its taps, one second apart from 13:00:01.250 WIB. */
function session(...payloads: SessionEventPayload[]): SessionState {
  const events = payloads.map((p, i): SessionEvent => ({
    ...p,
    sessionId: 's1',
    seq: i + 1,
    at: new Date(Date.UTC(2026, 9, 16, 6, 0, i + 1, 250)).toISOString(),
  }));
  return replay(events);
}

function check(state: SessionState, level: PsiLevel, photographed: DefectId[] = []) {
  return checkSubmit({
    state,
    level,
    top: top5(state, mapping),
    photographed: new Set(photographed),
  });
}

describe('checkSubmit (FR-11.1, doc 05 §13.1)', () => {
  it('stops while an inspection is active, before any other check', () => {
    expect(check(session(REWORK), 'PSI lv.2')).toEqual({ kind: 'ACTIVE' });
    expect(check(session(NO_DEFECT, BGRADE, defect('D035')), 'PSI lv.2')).toEqual({
      kind: 'ACTIVE',
    });
  });

  it('stops when Qty Inspection is 0', () => {
    expect(check(session(), 'PSI lv.1')).toEqual({ kind: 'EMPTY' });
    expect(check(session(NO_DEFECT, UNDO), 'PSI lv.2')).toEqual({ kind: 'EMPTY' });
  });

  it('lists the Top 5 defects without a photo for PSI lv.2, in rank order (BR-04)', () => {
    const state = session(REWORK, defect('D035'), defect('D082'), defect('D082'), END);
    const block = check(state, 'PSI lv.2', ['D082']);
    expect(block?.kind).toBe('PHOTOS_MISSING');
    expect(block?.kind === 'PHOTOS_MISSING' && block.defects.map((d) => d.defectId)).toEqual([
      'D035',
    ]);
    expect(check(state, 'PSI lv.2', ['D035', 'D082'])).toBeNull();
  });

  it('never asks PSI lv.1 for photos (AC-10.6)', () => {
    expect(check(session(REWORK, defect('D035'), END), 'PSI lv.1')).toBeNull();
  });

  it('lets an inspected session without defects through', () => {
    expect(check(session(NO_DEFECT), 'PSI lv.2')).toBeNull();
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
    NO_DEFECT,
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
      counts: { rework: 1, bGrade: 1, noDefect: 1 },
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

describe('submissionPhotos (AC-10.4, doc 02 §7)', () => {
  it('keeps the photo of a defect that left the Top 5', () => {
    // Six defects ranked by quantity: D001 drops to rank 6 but keeps its photo.
    const ids = ['D035', 'D082', 'D010', 'D020', 'D030'];
    const taps = ids.flatMap((id) => [defect(id), defect(id)]);
    const state = session(REWORK, defect('D001'), ...taps, END);
    expect(top5(state, mapping).map((d) => d.defectId)).not.toContain('D001');
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
