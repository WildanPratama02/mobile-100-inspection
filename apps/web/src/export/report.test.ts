import {
  defaultMapping,
  findings,
  rankDefects,
  replay,
  type CountingMode,
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
  factory: LV2.factory,
  cell: LV2.cell,
  partial: null,
  addedAt: '2026-10-19T00:00:00.000Z',
};

/**
 * Taps in order, one second apart, reduced by the shared engine like the store does: `ENTERED` (PSI lv.1) unless
 * told `TAPPED` (PSI lv.2, ADR-021).
 */
class Taps {
  private readonly events: SessionEvent[] = [];
  private readonly photos: Partial<Record<DefectId, PhotoRow>> = {};

  constructor(private readonly mode: CountingMode = 'ENTERED') {}

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
  qtyInspection() {
    return this.push({ type: 'SET_QTY_INSPECTION', qty: 30 });
  }
  end() {
    return this.push({ type: 'END' });
  }
  noDefect(times = 1) {
    for (let i = 0; i < times; i++) this.push({ type: 'NO_DEFECT' });
    return this;
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
      state: replay(this.events, this.mode),
      photos: this.photos,
    };
  }
}

const input = (taps: Taps | undefined, more: Partial<ExportInput> = {}): ExportInput => ({
  po: PO,
  session: taps?.session(),
  auth: LV2,
  mapping,
  ...more,
});

const name = (id: DefectId) => mapping.defect(id)!.name;

describe('exportReport (FR-12)', () => {
  describe('inspection date (AC-12.3)', () => {
    it('names the file PSI_<PO>_<YYYYMMDD> from the first event, never the export time', () => {
      const report = exportReport(input(new Taps().defect('D005')));
      expect(report.date).toBe('2026-10-19');
      expect(report.fileBase).toBe('PSI_0903359388_20261019');
    });

    it('uses the session creation when no event was recorded yet', () => {
      // createdAt is 08.00 WIB on 19 Oct.
      expect(exportReport(input(new Taps())).fileBase).toBe('PSI_0903359388_20261019');
    });

    it('falls back to the PO date for a PO without a session', () => {
      expect(exportReport(input(undefined)).fileBase).toBe('PSI_0903359388_20261019');
    });

    it('is a WIB date: 00.30 WIB on 20 Oct is 20 Oct', () => {
      const taps = new Taps().defect('D005');
      const base = taps.session();
      const session = {
        ...base,
        events: [{ ...base.events[0]!, at: '2026-10-19T17:30:00.000Z' }, ...base.events.slice(1)],
      };
      const report = exportReport(input(undefined, { session }));
      expect(report.date).toBe('2026-10-20');
      expect(report.fileBase).toBe('PSI_0903359388_20261020');
    });
  });

  it('carries the PO info, inspector, Factory/Cell and the inspection date (AC-12.1)', () => {
    const report = exportReport(input(new Taps().defect('D005')));
    expect(report.info).toEqual([
      ['PO NUMBER', '0903359388'],
      ['ARTIKEL', PO.article],
      ['MODEL', PO.model],
      ['DESTINATION', PO.destination],
      ['INSPEKTOR', 'DEWI CONTOH (PSI lv.2)'],
      ['FACTORY/CELL', 'F3-10'],
      ['DATE INSPECTION', '19 Okt 2026'],
    ]);
    expect(report.psiName).toBe('DEWI CONTOH (PSI lv.2)');
    expect(report.info.map(([label]) => label)).not.toContain('DICETAK');
  });

  it('adds PO PARTIAL when it is set', () => {
    const po = { ...PO, partial: { number: 1, qty: 1200 } };
    expect(exportReport(input(undefined, { po })).info).toContainEqual([
      'PARTIAL',
      'P1 · 1.200 dari 10.002',
    ]);
  });

  it('has the nine PDF results, including both rework figures (ADR-022)', () => {
    // Qty Inspection 30 with three findings, including one B-Grade finding and one rework pair.
    const taps = new Taps()
      .rework()
      .defect('D005')
      .defect('D049')
      .end()
      .bGrade()
      .defect('D035')
      .end()
      .qtyInspection();
    expect(exportReport(input(taps)).results).toEqual([
      { label: 'Qty PO Order', kind: 'count', value: 10002 },
      { label: 'Qty Inspection', kind: 'count', value: 30 },
      { label: 'Inspection Rework Qty', kind: 'count', value: 1 },
      { label: 'Qty Defect', kind: 'count', value: 3 },
      { label: 'Qty A-Grade', kind: 'count', value: 27 },
      { label: 'Qty B-Grade', kind: 'count', value: 1 },
      { label: 'Rework and Approved', kind: 'count', value: 0 },
      { label: 'Defect Rate', kind: 'rate', value: 0.1 },
      { label: 'Pass Rate (RFT)', kind: 'rate', value: 0.9 },
    ]);
  });

  it('has the KPI Summary and Daily Inspection Summary in the docs order (ADR-022)', () => {
    const taps = new Taps()
      .rework()
      .defect('D005')
      .defect('D049')
      .end()
      .bGrade()
      .defect('D035')
      .end()
      .qtyInspection();
    const report = exportReport(input(taps));

    expect(report.kpi).toEqual([
      { label: 'Inspected Qty', kind: 'count', value: 30 },
      { label: 'Inspected Qty (Including Rework)', kind: 'count', value: 31 },
      { label: 'Rejected Order Qty', kind: 'count', value: 3 },
      { label: 'RFT %', kind: 'rate', value: 0.9 },
      { label: 'Defect %', kind: 'rate', value: 0.1 },
      { label: 'Not Reworkable Defect Qty', kind: 'count', value: 1 },
      { label: 'Not Reworkable Defect %', kind: 'rate', value: 1 / 30 },
      { label: 'Total Approved Qty', kind: 'count', value: 27 },
    ]);

    expect(report.summary).toEqual([
      { label: 'PO No.', value: '0903359388' },
      { label: 'Model Name', value: PO.model },
      { label: 'Qty Order', value: 10002 },
      { label: 'Destination', value: PO.destination },
      { label: 'Offered Lot Qty', value: 10002 },
      { label: 'Inspected Qty', value: 30 },
      { label: 'Inspected Qty (Including Rework)', value: 31 },
      { label: 'Approved Qty', value: 27 },
      { label: 'Rejected Qty', value: 3 },
      { label: 'Rework and Approved', value: 0 },
      { label: 'Pairs Not Reworkable & Not Shippable (B&C Grade)', value: 1 },
      { label: 'Balance Rework', value: 1 },
      { label: 'Balance Qty', value: 9972 },
    ]);
  });

  it('uses the partial quantity as the offered lot', () => {
    const po = { ...PO, partial: { number: 1, qty: 1200 } };
    const report = exportReport(input(new Taps().qtyInspection(), { po }));
    expect(report.summary).toContainEqual({ label: 'Offered Lot Qty', value: 1200 });
    expect(report.summary).toContainEqual({ label: 'Balance Qty', value: 1170 });
  });

  it('PSI lv.2: Qty Inspection and A-Grade from NO DEFECT and ended inspections (ADR-021)', () => {
    const taps = new Taps('TAPPED')
      .noDefect(7)
      .rework()
      .defect('D005')
      .defect('D049')
      .end()
      .bGrade()
      .defect('D035')
      .end();
    const report = exportReport(input(taps));
    expect(report.results.map((r) => r.value)).toEqual([10002, 9, 1, 3, 7, 1, 0, 3 / 9, 7 / 9]);
    expect(report.kpi.map((r) => r.value)).toEqual([9, 9, 2, 7 / 9, 3 / 9, 1, 1 / 9, 7]);
    expect(report.summary).toContainEqual({ label: 'Balance Qty', value: 9993 });
  });

  it('exports an empty session with every figure 0 (doc 05 §8.5)', () => {
    for (const report of [
      exportReport(input(undefined)),
      exportReport(input(new Taps('TAPPED'))),
      exportReport(input(undefined, { auth: LV1 })),
      exportReport(input(new Taps(), { auth: LV1 })),
    ]) {
      expect(report.results.map((r) => r.value)).toEqual([10002, 0, 0, 0, 0, 0, 0, 0, 0]);
      expect(report.kpi.map((r) => r.value)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      expect(report.defects).toEqual([]);
      expect(report.photos).toEqual([]);
      expect(report.missingPhotos).toEqual([]);
    }
  });

  it('lists every finding defect in ranking order, not only five (ADR-022)', () => {
    const taps = new Taps()
      .rework()
      .defect('D049', 3)
      .defect('D005', 2)
      .defect('D035', 2)
      .defect('D001')
      .defect('D002')
      .defect('D003')
      .qtyInspection();
    const session = taps.session();
    const report = exportReport(input(undefined, { session }));

    expect(report.defects.map((d) => d.defectId)).toEqual(
      rankDefects(findings(session.state), (id) => mapping.defect(id)!.classification).map(
        (r) => r.defectId,
      ),
    );
    expect(report.defects).toHaveLength(6);
    expect(report.defects.map((d) => d.no)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(report.defects[0]).toMatchObject({
      no: 1,
      defectId: 'D049',
      name: name('D049'),
      classification: mapping.defect('D049')!.classification,
      qty: 3,
      rate: 3 / 30,
    });
    expect(report.defects[0]!.areas).not.toBe('');
  });

  describe('photos (PSI lv.2)', () => {
    it('names every defect without a photo, in ranking order (BR-04)', () => {
      const taps = new Taps().rework().defect('D005', 2).defect('D035').photo('D035');
      const report = exportReport(input(taps));
      expect(report.missingPhotos).toEqual([name('D005')]);
    });

    it('names a defect outside the first five without a photo too (ADR-022)', () => {
      // Seven defects, six photographed: D001 ranks 7th and is still required.
      const taps = new Taps().rework().defect('D001');
      for (const id of ['D002', 'D003', 'D004', 'D005', 'D006', 'D007'] as const) {
        taps.defect(id, 2).photo(id);
      }
      expect(exportReport(input(taps)).missingPhotos).toEqual([name('D001')]);
      taps.photo('D001');
      expect(exportReport(input(taps)).missingPhotos).toEqual([]);
    });

    it('PSI lv.1 never misses a photo (AC-10.6)', () => {
      const report = exportReport(input(new Taps().rework().defect('D005'), { auth: LV1 }));
      expect(report.missingPhotos).toEqual([]);
    });

    it('includes every photo of a current finding in ranking order, each once (AC-12.2)', () => {
      // Six defects, all photographed; D001 is last with one tap.
      const taps = new Taps().rework().defect('D001').photo('D001');
      for (const id of ['D002', 'D003', 'D004', 'D005', 'D006'] as const) {
        taps.defect(id, 2).photo(id);
      }
      const report = exportReport(input(taps));
      expect(report.photos.map((p) => [p.defectId, p.no])).toEqual(
        report.defects.map((d, i) => [d.defectId, i + 1]),
      );
      expect(report.photos).toHaveLength(6);
      expect(report.photos[5]!.name).toBe(name('D001'));
      expect(report.photos[5]!.no).toBe(6);
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
