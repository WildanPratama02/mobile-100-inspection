import {
  buildSubmission,
  countingMode,
  defaultMapping,
  findings,
  replay,
  top5,
  type CountingMode,
  type DefectId,
  type SessionEvent,
  type SessionEventPayload,
} from '@m100/shared';
import { describe, expect, it } from 'vitest';
import { ALL_PO_MASTER } from '../data/fixtures/pos';
import type { Auth, OutboxPhotoRow, OutboxRow, PhotoRow, PoRow } from '../db/schema';
import type { PoSession } from '../state/store';
import { sealedExport, type SealedExportInput } from './report';

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

// 14.05 WIB on 19 Oct 2026.
const NOW = new Date('2026-10-19T07:05:00Z');

/** When the fixture was submitted: 09.30 WIB on 19 Oct 2026. */
const SEALED_AT = '2026-10-19T02:30:00Z';

/**
 * Taps in order, one second apart, reduced by the shared engine like the store does: `ENTERED` (PSI lv.1) unless
 * told `TAPPED` (PSI lv.2, ADR-021). `outbox()` seals them into an `OutboxRow`, exactly like SUBMIT PO does.
 */
class Taps {
  private readonly events: SessionEvent[] = [];
  private readonly photos: Partial<Record<DefectId, PhotoRow>> = {};
  private readonly auth: Auth;
  private readonly mode: CountingMode;

  constructor(auth: Auth = LV2) {
    this.auth = auth;
    this.mode = countingMode(auth.level);
  }

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

  state() {
    return replay(this.events, this.mode);
  }

  session(): PoSession {
    return {
      session: {
        id: 's1',
        username: this.auth.username,
        po: PO.po,
        status: 'open',
        createdAt: '2026-10-19T01:00:00.000Z',
      },
      events: this.events,
      state: this.state(),
      photos: this.photos,
    };
  }

  /** The sealed outbox item SUBMIT PO would have stored for these taps. */
  outbox(): OutboxRow {
    const payload = buildSubmission({
      submissionUuid: 'u-1',
      sealedAt: SEALED_AT,
      appVersion: 'test',
      user: this.auth,
      cell: { factory: this.auth.factory, cell: this.auth.cell },
      po: PO.po,
      partial: PO.partial,
      state: this.state(),
      photos: Object.values(this.photos).map((p) => ({ defectId: p.defectId, sha256: p.sha256 })),
    });
    return {
      submissionUuid: 'u-1',
      po: PO.po,
      sealedAt: payload.sealedAt,
      payloadJson: JSON.stringify(payload),
      payloadSha256: 'sha256',
      authorUsername: LV2.username,
      authorToken: null,
      authorTokenExpiresAt: null,
      state: 'sent',
      attempts: 1,
      nextAttemptAt: SEALED_AT,
      lastAttemptAt: SEALED_AT,
      problem: null,
      problemErrors: [],
      displayNo: 'S-0001',
      sentAt: SEALED_AT,
    };
  }

  /** The photo blobs stored with the submission (`outboxPhotos`). */
  photoBlobs(): Pick<OutboxPhotoRow, 'defectId' | 'blob'>[] {
    return Object.values(this.photos).map(({ defectId, blob }) => ({ defectId, blob }));
  }
}

const input = (taps: Taps, more: Partial<SealedExportInput> = {}): SealedExportInput => ({
  po: PO,
  item: taps.outbox(),
  mapping,
  photoBlobs: taps.photoBlobs(),
  now: NOW,
  ...more,
});

const name = (id: DefectId) => mapping.defect(id)!.name;

describe('sealedExport (FR-12)', () => {
  it('names the file M100_<PO>_<YYYYMMDD> with the WIB date (AC-12.3)', () => {
    const taps = new Taps().qtyInspection();
    expect(sealedExport(input(taps)).fileBase).toBe('M100_0903359388_20261019');
    // 00.30 WIB on 20 Oct is still 19 Oct in UTC.
    const late = sealedExport(input(taps, { now: new Date('2026-10-19T17:30:00Z') }));
    expect(late.fileBase).toBe('M100_0903359388_20261020');
  });

  it('carries the PO info, inspector, Factory/Cell and export time (AC-12.1)', () => {
    const taps = new Taps().qtyInspection();
    expect(sealedExport(input(taps)).info).toEqual([
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
    const taps = new Taps().qtyInspection();
    const po = { ...PO, partial: { number: 1, qty: 1200 } };
    // the sealed submission carries its own partial (doc 04 §4.1)
    const item = { ...taps.outbox(), payloadJson: JSON.stringify({ ...JSON.parse(taps.outbox().payloadJson), partial: po.partial }) };
    expect(sealedExport({ ...input(taps), po, item }).info).toContainEqual([
      'PARTIAL',
      'P1 · 1.200 dari 10.002',
    ]);
  });

  it('refuses an outbox item of another PO', () => {
    const taps = new Taps().qtyInspection();
    expect(() => sealedExport(input(taps, { po: { ...PO, po: 'OTHER' } }))).toThrow(
      'Outbox item is for PO 0903359388, not OTHER',
    );
  });

  it('has the results panel values of the sealed submission (ADR-019)', () => {
    // PSI lv.1 (ENTERED): Qty Inspection 30 with three findings, including one B-Grade finding.
    const taps = new Taps(LV1)
      .rework()
      .defect('D005')
      .defect('D049')
      .end()
      .bGrade()
      .defect('D035')
      .end()
      .qtyInspection();
    expect(sealedExport(input(taps)).results).toEqual([
      { label: 'Qty PO Order', kind: 'count', value: 10002 },
      { label: 'Qty Inspection', kind: 'count', value: 30 },
      { label: 'Qty Defect', kind: 'count', value: 3 },
      { label: 'Qty A-Grade', kind: 'count', value: 27 },
      { label: 'Qty B-Grade', kind: 'count', value: 1 },
      { label: 'Defect Rate', kind: 'rate', value: 0.1 },
      { label: 'Pass Rate (RFT)', kind: 'rate', value: 0.9 },
    ]);
  });

  it('PSI lv.2: Qty Inspection and A-Grade from NO DEFECT and ended inspections (ADR-021)', () => {
    const taps = new Taps()
      .noDefect(7)
      .rework()
      .defect('D005')
      .defect('D049')
      .end()
      .bGrade()
      .defect('D035')
      .end();
    expect(sealedExport(input(taps)).results.map((r) => r.value)).toEqual([
      10002,
      9,
      3,
      7,
      1,
      3 / 9,
      7 / 9,
    ]);
  });

  it('has the same TOP 5 DEFECT as Home (AC-05.1)', () => {
    const taps = new Taps()
      .rework()
      .defect('D049', 3)
      .defect('D005', 2)
      .defect('D035', 2)
      .defect('D001')
      .defect('D002')
      .defect('D003')
      .qtyInspection();
    const report = sealedExport(input(taps));
    expect(report.top5.map((t) => t.defectId)).toEqual(
      top5(findings(taps.session().state), mapping).map((r) => r.defectId),
    );
    expect(report.top5).toHaveLength(5);
    expect(report.top5[0]).toMatchObject({
      no: 1,
      defectId: 'D049',
      name: name('D049'),
      classification: mapping.defect('D049')!.classification,
      qty: 3,
    });
    expect(report.top5[0]).not.toHaveProperty('photo');
    expect(report.top5[0]!.areas).not.toBe('');
  });

  it('has no full defect list (ADR-021)', () => {
    const taps = new Taps().rework().defect('D049').defect('D071').end().qtyInspection();
    expect(sealedExport(input(taps))).not.toHaveProperty('defects');
  });

  it('the submission passed BR-04, so nothing is reported as missing', () => {
    const taps = new Taps().rework().defect('D005').photo('D005').qtyInspection();
    expect(sealedExport(input(taps)).missingPhotos).toEqual([]);
  });

  describe('photos (PSI lv.2)', () => {
    it('includes every photo of a current finding, Top 5 first, each once (AC-12.2, AC-10.4)', () => {
      // D001 has a photo and drops to rank 6 once five defects have more taps.
      const taps = new Taps().rework().defect('D001').photo('D001');
      for (const id of ['D002', 'D003', 'D004', 'D005', 'D006'] as const) {
        taps.defect(id, 2).photo(id);
      }
      const report = sealedExport(input(taps));
      const shown = top5(findings(taps.session().state), mapping).map((r) => r.defectId);
      expect(shown).not.toContain('D001');
      expect(report.photos.map((p) => [p.defectId, p.top5No])).toEqual([
        ...shown.map((id, i) => [id, i + 1]),
        ['D001', null],
      ]);
      expect(report.photos[5]!.name).toBe(name('D001'));
    });

    it('leaves out the photo of a defect that was undone completely', () => {
      const taps = new Taps(LV1).rework().defect('D005').defect('D035').photo('D035').undo().qtyInspection();
      const report = sealedExport(input(taps));
      expect(report.top5.map((d) => d.defectId)).toEqual(['D005']);
      expect(report.photos).toEqual([]);
    });

    it('PSI lv.1 exports without photos (AC-10.6)', () => {
      const taps = new Taps(LV1).rework().defect('D005').qtyInspection();
      const report = sealedExport(input(taps));
      expect(report.photos).toEqual([]);
      expect(report.missingPhotos).toEqual([]);
    });
  });

  it('only reads its input (AC-12.4)', () => {
    const taps = new Taps().rework().defect('D005', 2).defect('D035').photo('D035').qtyInspection();
    const before = JSON.stringify({ PO, item: taps.outbox() });
    sealedExport(input(taps));
    expect(JSON.stringify({ PO, item: taps.outbox() })).toBe(before);
  });
});
