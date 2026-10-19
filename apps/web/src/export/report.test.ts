import {
  defaultMapping,
  replay,
  top5,
  type DefectId,
  type SessionEvent,
  type SessionEventPayload,
} from '@m100/shared';
import { describe, expect, it } from 'vitest';
import { ALL_PO_MASTER } from '../data/fixtures/pos';
import type { Auth, PhotoRow, PoRow } from '../db/schema';
import type { PoSession } from '../state/store';
import { exportReport, type ExportInput } from './report';

const mapping = defaultMapping();

const LV2: Auth = {
  username: 'DEWI CONTOH',
  level: 'PSI lv.2',
  factory: 'F 3',
  cell: 'F3-10',
  token: null,
  tokenExpiresAt: null,
};
const LV1: Auth = { ...LV2, username: 'ANDI CONTOH', level: 'PSI lv.1' };

const PO: PoRow = {
  ...ALL_PO_MASTER.find((p) => p.po === '0903359388')!,
  username: LV2.username,
  partial: null,
  addedAt: '2026-10-19T00:00:00.000Z',
};

// 14.05 WIB on 19 Oct 2026.
const NOW = new Date('2026-10-19T07:05:00Z');

/** Taps in order, one second apart, reduced by the shared engine like the store does. */
class Taps {
  private readonly events: SessionEvent[] = [];
  private readonly photos: Partial<Record<DefectId, PhotoRow>> = {};

  private push(payload: SessionEventPayload): this {
    const seq = this.events.length + 1;
    const at = new Date(Date.UTC(2026, 9, 19, 1, 0, seq)).toISOString();
    this.events.push({ ...payload, sessionId: 's1', seq, at });
    return this;
  }

  rework() {
    return this.push({ type: 'START_REWORK' });
  }
  bGrade() {
    return this.push({ type: 'START_BGRADE' });
  }
  noDefect() {
    return this.push({ type: 'NO_DEFECT' });
  }
  end() {
    return this.push({ type: 'END' });
  }
  undo() {
    return this.push({ type: 'UNDO' });
  }
  /** A defect in its first mapped area, or in `areaId` when given. */
  defect(defectId: DefectId, times = 1, areaId?: string) {
    const entry = mapping.map.find(
      (e) => e.defectId === defectId && (!areaId || e.areaId === areaId),
    )!;
    for (let i = 0; i < times; i++) this.push({ type: 'DEFECT', ...entry });
    return this;
  }
  photo(defectId: DefectId) {
    this.photos[defectId] = {
      sessionId: 's1',
      defectId,
      blob: new Blob([defectId], { type: 'image/jpeg' }),
      sha256: defectId,
      takenAt: '2026-10-19T02:00:00.000Z',
    };
    return this;
  }

  session(): PoSession {
    return {
      session: {
        id: 's1',
        username: LV2.username,
        po: PO.po,
        status: 'open',
        createdAt: '2026-10-19T01:00:00.000Z',
      },
      events: this.events,
      state: replay(this.events),
      photos: this.photos,
    };
  }
}

const input = (taps: Taps | undefined, more: Partial<ExportInput> = {}): ExportInput => ({
  po: PO,
  session: taps?.session(),
  auth: LV2,
  mapping,
  now: NOW,
  ...more,
});

const name = (id: DefectId) => mapping.defect(id)!.name;

describe('exportReport (FR-12)', () => {
  it('names the file M100_<PO>_<YYYYMMDD> with the WIB date (AC-12.3)', () => {
    expect(exportReport(input(undefined)).fileBase).toBe('M100_0903359388_20261019');
    // 00.30 WIB on 20 Oct is still 19 Oct in UTC.
    const late = exportReport(input(undefined, { now: new Date('2026-10-19T17:30:00Z') }));
    expect(late.fileBase).toBe('M100_0903359388_20261020');
  });

  it('carries the PO info, inspector, Factory/Cell and export time (AC-12.1)', () => {
    expect(exportReport(input(undefined)).info).toEqual([
      ['PO NUMBER', '0903359388'],
      ['ARTIKEL', PO.article],
      ['MODEL', PO.model],
      ['DESTINATION', PO.destination],
      ['INSPEKTOR', 'DEWI CONTOH (PSI lv.2)'],
      ['FACTORY/CELL', 'F3-10'],
      ['DICETAK', '19 Okt 2026 14.05 WIB'],
    ]);
  });

  it('adds PO PARTIAL when it is set', () => {
    const po = { ...PO, partial: { number: 1, qty: 1200 } };
    expect(exportReport(input(undefined, { po })).info).toContainEqual([
      'PARTIAL',
      'P1 · 1.200 dari 10.002',
    ]);
  });

  it('has the results panel values (ADR-008)', () => {
    // REWORK pair with 2 defects, B-GRADE pair with 1, one NO DEFECT: 3 inspected, 3 defects, 1 B-Grade.
    const taps = new Taps()
      .rework()
      .defect('D005')
      .defect('D049')
      .end()
      .bGrade()
      .defect('D035')
      .end()
      .noDefect();
    expect(exportReport(input(taps)).results).toEqual([
      { label: 'Qty PO Order', kind: 'count', value: 10002 },
      { label: 'Qty Inspection', kind: 'count', value: 3 },
      { label: 'Qty Defect', kind: 'count', value: 3 },
      { label: 'Qty A-Grade', kind: 'count', value: 1 },
      { label: 'Qty B-Grade', kind: 'count', value: 1 },
      { label: 'Defect Rate', kind: 'rate', value: 1 },
      { label: 'Pass Rate (RFT)', kind: 'rate', value: 1 / 3 },
    ]);
  });

  it('exports an empty session with zeros and no rate (doc 05 §8.5)', () => {
    for (const report of [exportReport(input(undefined)), exportReport(input(new Taps()))]) {
      expect(report.results.map((r) => r.value)).toEqual([10002, 0, 0, 0, 0, null, null]);
      expect(report.top5).toEqual([]);
      expect(report.defects).toEqual([]);
      expect(report.photos).toEqual([]);
      expect(report.missingPhotos).toEqual([]);
    }
  });

  it('has the same TOP 5 DEFECT as Home (AC-05.1)', () => {
    const taps = new Taps()
      .rework()
      .defect('D049', 3)
      .defect('D005', 2)
      .defect('D035', 2)
      .defect('D001')
      .defect('D002')
      .defect('D003');
    const report = exportReport(input(taps, { auth: LV1 }));
    expect(report.top5.map((t) => t.defectId)).toEqual(
      top5(taps.session().state, mapping).map((r) => r.defectId),
    );
    expect(report.top5).toHaveLength(5);
    expect(report.top5[0]).toMatchObject({
      no: 1,
      defectId: 'D049',
      name: name('D049'),
      classification: mapping.defect('D049')!.classification,
      qty: 3,
      photo: null,
    });
    expect(report.top5[0]!.areas).not.toBe('');
  });

  it('lists every finding with area, sub-area, family, inspection type, classification and qty', () => {
    const taps = new Taps().rework().defect('D049').defect('D071').defect('D049').end();
    taps.bGrade().defect('D049').end();
    const rows = exportReport(input(taps)).defects;
    const entry49 = mapping.map.find((e) => e.defectId === 'D049')!;
    expect(rows).toEqual([
      {
        no: 1,
        inspectionType: 'REWORK',
        area: mapping.area(entry49.areaId)!.name,
        subArea: mapping.subArea(entry49.subAreaId)!.name,
        family: mapping.family(entry49.familyId)!.name,
        defectId: 'D049',
        name: name('D049'),
        classification: mapping.defect('D049')!.classification,
        qty: 2,
      },
      expect.objectContaining({ no: 2, inspectionType: 'REWORK', defectId: 'D071', qty: 1 }),
      expect.objectContaining({ no: 3, inspectionType: 'B-GRADE', defectId: 'D049', qty: 1 }),
    ]);
    // D049 and D071 share a name but stay apart (ADR-009).
    expect(name('D049')).toBe(name('D071'));
  });

  describe('photos (PSI lv.2)', () => {
    it('marks Top 5 rows with and without a photo, and names the missing ones (BR-04)', () => {
      const taps = new Taps().rework().defect('D005', 2).defect('D035').photo('D035');
      const report = exportReport(input(taps));
      expect(report.top5.map((t) => [t.defectId, t.photo])).toEqual([
        ['D005', false],
        ['D035', true],
      ]);
      expect(report.missingPhotos).toEqual([name('D005')]);
    });

    it('PSI lv.1 has no photo column and never misses a photo (AC-10.6)', () => {
      const report = exportReport(input(new Taps().rework().defect('D005'), { auth: LV1 }));
      expect(report.top5[0]!.photo).toBeNull();
      expect(report.missingPhotos).toEqual([]);
    });

    it('includes every photo of a current finding, Top 5 first, each once (AC-12.2, AC-10.4)', () => {
      // D001 has a photo and drops to rank 6 once five defects have more taps.
      const taps = new Taps().rework().defect('D001').photo('D001');
      for (const id of ['D002', 'D003', 'D004', 'D005', 'D006'] as const) {
        taps.defect(id, 2).photo(id);
      }
      const report = exportReport(input(taps));
      const shown = top5(taps.session().state, mapping).map((r) => r.defectId);
      expect(shown).not.toContain('D001');
      expect(report.photos.map((p) => [p.defectId, p.top5No])).toEqual([
        ...shown.map((id, i) => [id, i + 1]),
        ['D001', null],
      ]);
      expect(report.photos[5]!.name).toBe(name('D001'));
    });

    it('leaves out the photo of a defect that was undone completely', () => {
      const taps = new Taps().rework().defect('D005').defect('D035').photo('D035').undo();
      const report = exportReport(input(taps));
      expect(report.defects.map((d) => d.defectId)).toEqual(['D005']);
      expect(report.photos).toEqual([]);
    });
  });

  it('only reads its input (AC-12.4)', () => {
    const taps = new Taps().rework().defect('D005', 2).defect('D035').photo('D035');
    const session = taps.session();
    const before = JSON.stringify({ PO, session });
    exportReport(input(undefined, { session }));
    expect(JSON.stringify({ PO, session })).toBe(before);
  });
});
