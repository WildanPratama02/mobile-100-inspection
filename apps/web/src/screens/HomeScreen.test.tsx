import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  defaultMapping,
  formatPartial,
  type AreaMapEntry,
  type Classification,
  type Po,
} from '@m100/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../app/toast';
import { ALL_PO_MASTER } from '../data/fixtures/pos';
import { createDb, type Auth, type M100Db, type OutboxRow } from '../db/schema';
import type { OutboxSender } from '../outbox/sender';
import { OutboxSenderContext } from '../outbox/useOutboxSender';
import { exportFile } from '../export/exportFile';
import { saveFile } from '../export/saveFile';
import { toJpeg } from '../photos/resize';
import { AppStoreContext, createAppStore, type AppStore, type TapCommand } from '../state/store';
import { HomeScreen, LONG_PRESS_MS } from './HomeScreen';

// jsdom has no canvas: the resize itself is covered by the Playwright test (e2e/photos.spec.ts).
vi.mock('../photos/resize', () => ({ toJpeg: vi.fn() }));
// The files themselves are tested in src/export and e2e/export.spec.ts; here only what Home does with them.
vi.mock('../export/exportFile', () => ({ exportFile: vi.fn() }));
vi.mock('../export/saveFile', () => ({ saveFile: vi.fn() }));

const AUTH: Auth = {
  username: 'DEWI CONTOH',
  level: 'PSI lv.2',
  factory: 'F 3',
  cell: 'F3-10',
  token: null,
  tokenExpiresAt: null,
};
const PO: Po = ALL_PO_MASTER.find((p) => p.po === '0903359388')!;
const CX: Po = ALL_PO_MASTER.find((p) => p.po === 'CX-0902368685')!;

const mapping = defaultMapping();

/** A map entry of the given classification, in the given area, other than the ones in `not`. */
function entry(classification: Classification, areaId: string, not: AreaMapEntry[] = []) {
  const found = mapping.map.find(
    (e) =>
      e.areaId === areaId &&
      mapping.defect(e.defectId)?.classification === classification &&
      !not.some((n) => n.defectId === e.defectId),
  );
  if (!found) throw new Error(`No ${classification} defect in ${areaId}`);
  return found;
}

const nameOf = (e: AreaMapEntry) => mapping.defect(e.defectId)!.name;

let db: M100Db;
let store: AppStore;

beforeEach(async () => {
  db = createDb(`home-${crypto.randomUUID()}`);
  store = createAppStore(db);
  await store.getState().hydrate();
  await store.getState().login(AUTH);
});

afterEach(async () => {
  await db.delete();
});

function renderHome(auth: Auth = AUTH) {
  render(
    <AppStoreContext.Provider value={store}>
      <ToastProvider>
        <HomeScreen auth={auth} />
      </ToastProvider>
    </AppStoreContext.Provider>,
  );
}

async function tap(po: string, ...commands: TapCommand[]) {
  for (const command of commands) {
    await act(async () => {
      expect(await store.getState().tap(po, command)).not.toBeNull();
    });
  }
}

const defect = (e: AreaMapEntry): TapCommand => ({ type: 'DEFECT', entry: e });
const START_REWORK: TapCommand = { type: 'START', inspection: 'REWORK' };
const START_BGRADE: TapCommand = { type: 'START', inspection: 'B-GRADE' };
const END: TapCommand = { type: 'END' };

/** The value shown beside a results label. */
function stat(label: string): string {
  const row = within(screen.getByRole('region', { name: 'Hasil' }))
    .getByText(label)
    .closest('.m100-stat');
  return row?.querySelector('b')?.textContent ?? '';
}

const infoValue = (label: string) =>
  within(screen.getByLabelText('Info PO')).getByText(label).nextElementSibling?.textContent;

const top5Names = () =>
  within(screen.getByRole('region', { name: 'TOP 5 DEFECT' }))
    .queryAllByRole('listitem')
    .map((row) => row.querySelector('.m100-t5__nm')?.firstChild?.textContent);

const BOTTOM = ['ADD DEFECT', 'EXPORT PDF', 'EXPORT EXCEL', 'SUBMIT PO'];

describe('Home states (doc 05 §8.2)', () => {
  it('without a PO: says how to add one, shows "-" and empty results, disables the bottom row', () => {
    renderHome();
    expect(screen.getByText('Belum ada PO')).toBeInTheDocument();
    expect(screen.getByText('Tekan tombol + di PO List untuk menambahkan PO.')).toBeInTheDocument();
    expect(infoValue('PO NUMBER')).toBe('-');
    expect(infoValue('FACTORY/CELL')).toBe('F3-10');
    expect(stat('Qty PO Order')).toBe('—');
    expect(stat('Qty Inspection')).toBe('0');
    expect(stat('Defect Rate')).toBe('—');
    for (const name of BOTTOM) expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'PO PARTIAL' })).not.toBeInTheDocument();
  });

  it('with a PO and an empty session: says how to start, zeros and "—" (AC-05.2)', async () => {
    await store.getState().addPo(PO, null);
    renderHome();
    expect(screen.getByText('Belum ada defect')).toBeInTheDocument();
    expect(screen.getByText('Tekan ADD DEFECT untuk mulai input.')).toBeInTheDocument();
    expect(infoValue('PO NUMBER')).toBe('0903359388');
    expect(infoValue('ARTIKEL')).toBe(PO.article);
    expect(infoValue('MODEL')).toBe(PO.model);
    expect(infoValue('DESTINATION')).toBe(PO.destination);
    expect(stat('Qty PO Order')).toBe('10.002');
    expect(stat('Qty Inspection')).toBe('0');
    expect(stat('Pass Rate (RFT)')).toBe('—');
    for (const name of BOTTOM) expect(screen.getByRole('button', { name })).toBeEnabled();
  });

  it('while an inspection is active: marks the PO and says how to go on', async () => {
    await store.getState().addPo(PO, null);
    renderHome();
    expect(screen.queryByText(/^Inspeksi berjalan\./)).not.toBeInTheDocument();
    await tap(PO.po, START_BGRADE, defect(entry('MAJOR', 'A01')));

    const row = screen.getByRole('button', { name: /^0903359388/ });
    expect(row).toHaveTextContent('Inspeksi berjalan · B-GRADE');
    expect(
      screen.getByText(
        'Inspeksi berjalan. Lanjutkan di ADD DEFECT atau selesaikan dengan END INSPECTION.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SUBMIT PO' })).toBeEnabled();
  });
});

describe('results panel (FR-04, AC-04.1)', () => {
  it('follows every tap, with ADR-008 counts and id-ID rates', async () => {
    await store.getState().addPo(PO, null);
    renderHome();
    const a = entry('MINOR', 'A01');
    const b = entry('MAJOR', 'A02');

    await tap(PO.po, START_REWORK, defect(a), defect(b), END);
    expect(stat('Qty Inspection')).toBe('1');
    expect(stat('Qty Defect')).toBe('2');
    expect(stat('Defect Rate')).toBe('200,0%');
    expect(stat('Pass Rate (RFT)')).toBe('0,0%');

    await tap(PO.po, START_BGRADE, defect(a), END, { type: 'NO_DEFECT' });
    expect(stat('Qty Inspection')).toBe('3');
    expect(stat('Qty Defect')).toBe('3');
    expect(stat('Qty A-Grade')).toBe('1');
    expect(stat('Qty B-Grade')).toBe('1');
    expect(stat('Defect Rate')).toBe('100,0%');
    expect(stat('Pass Rate (RFT)')).toBe('33,3%');

    await tap(PO.po, { type: 'UNDO' });
    expect(stat('Qty Inspection')).toBe('2');
    expect(stat('Qty A-Grade')).toBe('0');
  });

  it('marks Defect Rate above 5,0% only (U3)', async () => {
    await store.getState().addPo(PO, null);
    renderHome();
    const rate = () =>
      within(screen.getByRole('region', { name: 'Hasil' }))
        .getByText('Defect Rate')
        .closest('.m100-stat');
    for (let i = 0; i < 19; i++) await tap(PO.po, { type: 'NO_DEFECT' });
    await tap(PO.po, START_REWORK, defect(entry('MINOR', 'A01')), END);
    expect(stat('Defect Rate')).toBe('5,0%');
    expect(rate()).not.toHaveClass('m100-stat--bad');

    await tap(PO.po, START_REWORK, defect(entry('MINOR', 'A01')));
    expect(stat('Defect Rate')).toBe('9,5%');
    expect(rate()).toHaveClass('m100-stat--bad');
  });
});

describe('TOP 5 DEFECT (FR-05)', () => {
  it('orders by quantity, then CRITICAL › MAJOR › MINOR, then first recorded (AC-05.1)', async () => {
    await store.getState().addPo(PO, null);
    renderHome();
    const minor = entry('MINOR', 'A01');
    const major = entry('MAJOR', 'A01');
    const critical = mapping.map.find(
      (e) => mapping.defect(e.defectId)?.classification === 'CRITICAL',
    )!;
    const minorTwice = entry('MINOR', 'A02', [minor]);
    const minorLater = entry('MINOR', 'A01', [minor, minorTwice]);

    await tap(PO.po, START_REWORK, defect(minor), defect(major), defect(critical));
    await tap(PO.po, defect(minorTwice), defect(minorTwice), defect(minorLater));

    expect(top5Names()).toEqual([
      nameOf(minorTwice),
      nameOf(critical),
      nameOf(major),
      nameOf(minor),
      nameOf(minorLater),
    ]);
  });

  it('sums a defect across areas and lists those areas as on the shoe map', async () => {
    await store.getState().addPo(PO, null);
    renderHome();
    const vamp = entry('MAJOR', 'A02');
    const toe = mapping.map.find((e) => e.areaId === 'A01' && e.defectId === vamp.defectId)!;
    await tap(PO.po, START_REWORK, defect(vamp), defect(toe), defect(toe));

    const [row] = within(screen.getByRole('region', { name: 'TOP 5 DEFECT' })).getAllByRole(
      'listitem',
    );
    expect(row).toHaveTextContent('VAMP, TOE BOX');
    expect(row).toHaveTextContent('MAJOR');
    expect(row?.querySelector('.m100-t5__q')).toHaveTextContent('3');
    // PSI lv.2: the row carries its photo control (FR-10).
    expect(within(row!).getByRole('button', { name: 'Foto wajib' })).toBeInTheDocument();
  });

  it('shows five defects at most', async () => {
    await store.getState().addPo(PO, null);
    renderHome();
    const seen: AreaMapEntry[] = [];
    for (let i = 0; i < 7; i++) seen.push(entry('MINOR', 'A01', seen));
    await tap(PO.po, START_REWORK, ...seen.map(defect));
    expect(top5Names()).toHaveLength(5);
  });
});

describe('PO list (FR-03)', () => {
  it('keeps leading zeros and prefixes, and shows each PO with its defect count (AC-03.2, AC-03.5)', async () => {
    await store.getState().addPo(PO, null);
    await store.getState().addPo(CX, null);
    renderHome();
    const list = screen.getByRole('region', { name: 'PO LIST' });
    const rows = within(list).getAllByRole('button', { name: /^(0|CX)/ });
    expect(rows.map((r) => r.firstChild?.textContent)).toEqual(['CX-0902368685', '0903359388']);
    expect(rows[1]).toHaveTextContent(`${PO.model} · ${PO.destination}`);

    await tap(PO.po, START_REWORK, defect(entry('MINOR', 'A01')), defect(entry('MINOR', 'A01')));
    expect(within(rows[1]!).getByLabelText('2 defect')).toHaveTextContent('2');
  });

  it('selecting a PO switches the info strip and the results (AC-03.3)', async () => {
    await store.getState().addPo(PO, null);
    await store.getState().addPo(CX, null);
    await tap(PO.po, { type: 'NO_DEFECT' });
    renderHome();
    expect(infoValue('PO NUMBER')).toBe('CX-0902368685');
    expect(stat('Qty PO Order')).toBe('2.400');
    expect(stat('Qty Inspection')).toBe('0');

    fireEvent.click(screen.getByRole('button', { name: /^0903359388/ }));
    await waitFor(() => expect(infoValue('PO NUMBER')).toBe('0903359388'));
    expect(screen.getByRole('button', { name: /^0903359388/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(stat('Qty PO Order')).toBe('10.002');
    expect(stat('Qty Inspection')).toBe('1');
  });

  it('shows the partial with UBAH PARTIAL, or PO PARTIAL without one (U9)', async () => {
    await store.getState().addPo(PO, { number: 1, qty: 1200 });
    renderHome();
    expect(infoValue('PARTIAL')).toBe('P1 · 1.200 dari 10.002');
    expect(screen.getByRole('button', { name: 'UBAH PARTIAL' })).toBeInTheDocument();

    await act(() => store.getState().setPartial(PO.po, null));
    expect(screen.queryByText('PARTIAL')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PO PARTIAL' })).toBeInTheDocument();
  });
});

describe('removing a PO by long press (AC-03.4)', () => {
  const longPress = async (name: RegExp) => {
    const row = screen.getByRole('button', { name });
    fireEvent.pointerDown(row);
    await act(() => new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 50)));
    fireEvent.pointerUp(row);
    fireEvent.click(row);
  };

  it('asks first, then removes a PO without data', async () => {
    await store.getState().addPo(CX, null);
    await store.getState().addPo(PO, null);
    renderHome();
    await longPress(/^CX-0902368685/);

    const dialog = screen.getByRole('dialog', { name: 'Hapus PO dari list?' });
    expect(dialog).toHaveTextContent('CX-0902368685');
    // The click that ends the long press does not select the PO.
    expect(infoValue('PO NUMBER')).toBe('0903359388');

    fireEvent.click(within(dialog).getByRole('button', { name: 'BATAL' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^CX-0902368685/ })).toBeInTheDocument();

    await longPress(/^CX-0902368685/);
    fireEvent.click(screen.getByRole('button', { name: 'HAPUS' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^CX-0902368685/ })).not.toBeInTheDocument(),
    );
    expect(await db.pos.count()).toBe(1);
  });

  it('does not respond on a PO with data, and a short tap only selects', async () => {
    await store.getState().addPo(PO, null);
    await store.getState().addPo(CX, null);
    await tap(PO.po, START_REWORK);
    renderHome();
    await longPress(/^0903359388/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(infoValue('PO NUMBER')).toBe('0903359388'));
  });
});

describe('photos (FR-10, doc 05 §12)', () => {
  const LV1: Auth = { ...AUTH, username: 'ANDI CONTOH', level: 'PSI lv.1' };
  const shot = (name = 'shot.jpg') => new File(['raw'], name, { type: 'image/jpeg' });
  let hashes = 0;

  beforeEach(() => {
    hashes = 0;
    vi.mocked(toJpeg).mockReset();
    vi.mocked(toJpeg).mockImplementation(() =>
      Promise.resolve({
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
        sha256: `hash-${++hashes}`,
      }),
    );
  });

  const rows = () =>
    within(screen.getByRole('region', { name: 'TOP 5 DEFECT' })).getAllByRole('listitem');
  const camera = () => screen.getByTestId<HTMLInputElement>('camera');
  const stored = () => store.getState().sessions[PO.po]!.photos;

  /** What the camera hands back: a file, or nothing when it is cancelled. Callers wait for the result. */
  function returnFromCamera(...files: File[]) {
    fireEvent.change(camera(), { target: { files } });
  }

  async function withDefects(...entries: AreaMapEntry[]) {
    await store.getState().addPo(PO, null);
    await store.getState().tap(PO.po, START_REWORK);
    for (const e of entries) await store.getState().tap(PO.po, defect(e));
  }

  it('marks a Top 5 row without a photo and counts the missing photos (AC-10.3)', async () => {
    const a = entry('MAJOR', 'A01');
    const b = entry('MINOR', 'A01');
    await withDefects(a, b);
    renderHome();

    for (const row of rows()) {
      expect(within(row).getByRole('button', { name: 'Foto wajib' })).toBeInTheDocument();
      expect(row.querySelector('.m100-t5__flag')).toHaveTextContent('Foto wajib');
    }
    expect(screen.getByText('2 foto belum ada.')).toBeInTheDocument();
    expect(
      screen.getByText(
        /PSI lv.2 wajib melampirkan foto pada setiap Top 5 Defect sebelum SUBMIT PO/,
      ),
    ).toBeInTheDocument();
  });

  it('opens the camera, stores the resized photo and shows its thumbnail (S7a, AC-10.1, AC-10.2)', async () => {
    const a = entry('MAJOR', 'A01');
    await withDefects(a);
    renderHome();
    const click = vi.spyOn(camera(), 'click');

    fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'Foto wajib' }));
    expect(click).toHaveBeenCalledOnce();
    expect(camera()).toHaveAttribute('accept', 'image/*');
    expect(camera()).toHaveAttribute('capture', 'environment');
    returnFromCamera(shot());

    expect(await screen.findByText('Foto tersimpan')).toBeInTheDocument();
    expect(toJpeg).toHaveBeenCalledOnce();
    expect(stored()[a.defectId]?.sha256).toBe('hash-1');
    const row = rows()[0]!;
    expect(
      within(row).getByRole('button', { name: `Lihat foto ${nameOf(a)}` }),
    ).toBeInTheDocument();
    expect(row.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/);
    expect(row.querySelector('.m100-t5__flag')).toBeNull();
    expect(screen.queryByText(/foto belum ada/)).not.toBeInTheDocument();
  });

  it('changes nothing when the camera is cancelled', async () => {
    await withDefects(entry('MAJOR', 'A01'));
    renderHome();
    fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'Foto wajib' }));
    returnFromCamera();
    expect(toJpeg).not.toHaveBeenCalled();
    expect(stored()).toEqual({});
    expect(screen.queryByText('Foto tersimpan')).not.toBeInTheDocument();
  });

  it('says so when the photo cannot be processed, and keeps the row as it was', async () => {
    vi.mocked(toJpeg).mockRejectedValueOnce(new Error('decode failed'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await withDefects(entry('MAJOR', 'A01'));
    renderHome();
    fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'Foto wajib' }));
    returnFromCamera(shot());

    expect(await screen.findByText('Foto gagal disimpan. Coba lagi.')).toBeInTheDocument();
    expect(stored()).toEqual({});
    expect(within(rows()[0]!).getByRole('button', { name: 'Foto wajib' })).toBeInTheDocument();
  });

  it('shows the photo large; GANTI FOTO replaces it and HAPUS removes it (S7b, AC-10.5)', async () => {
    const a = entry('CRITICAL', 'A01');
    await withDefects(a);
    renderHome();
    fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'Foto wajib' }));
    returnFromCamera(shot());
    await screen.findByText('Foto tersimpan');

    fireEvent.click(screen.getByRole('button', { name: `Lihat foto ${nameOf(a)}` }));
    const view = screen.getByRole('dialog', { name: 'Foto defect' });
    expect(view).toHaveTextContent(nameOf(a));
    expect(view).toHaveTextContent('CRITICAL');
    expect(within(view).getByRole('img', { name: `Foto defect ${nameOf(a)}` })).toBeInTheDocument();

    fireEvent.click(within(view).getByRole('button', { name: 'GANTI FOTO' }));
    returnFromCamera(shot('second.jpg'));
    await waitFor(() => expect(stored()[a.defectId]?.sha256).toBe('hash-2'));
    expect(await db.photos.count()).toBe(1);
    expect(screen.queryByRole('dialog', { name: 'Foto defect' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: `Lihat foto ${nameOf(a)}` }));
    fireEvent.click(screen.getByRole('button', { name: 'HAPUS' }));
    expect(await screen.findByText('Foto dihapus')).toBeInTheDocument();
    expect(stored()).toEqual({});
    expect(await db.photos.count()).toBe(0);
    expect(within(rows()[0]!).getByRole('button', { name: 'Foto wajib' })).toBeInTheDocument();
  });

  it('keeps the photo of a defect that leaves the Top 5, without showing it (AC-10.4)', async () => {
    const seen: AreaMapEntry[] = [];
    for (let i = 0; i < 6; i++) seen.push(entry('MINOR', 'A01', seen));
    const [first, ...others] = seen as [AreaMapEntry, ...AreaMapEntry[]];
    await withDefects(first);
    renderHome();
    fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'Foto wajib' }));
    returnFromCamera(shot());
    await screen.findByText('Foto tersimpan');

    // Five other defects, twice each, push the photographed one out of the Top 5.
    for (const e of others) await tap(PO.po, defect(e), defect(e));

    expect(top5Names()).not.toContain(nameOf(first));
    expect(stored()[first.defectId]?.sha256).toBe('hash-1');
    expect(screen.queryByRole('button', { name: /^Lihat foto/ })).not.toBeInTheDocument();
    expect(screen.getByText('5 foto belum ada.')).toBeInTheDocument();
  });

  it('shows no photo column, no flag, no notice and no camera for PSI lv.1 (AC-10.6)', async () => {
    await store.getState().logout();
    await store.getState().login(LV1);
    await withDefects(entry('MAJOR', 'A01'));
    renderHome(LV1);

    expect(rows()[0]!.querySelector('.m100-t5--nophoto')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /foto/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Foto wajib')).not.toBeInTheDocument();
    expect(screen.queryByText(/foto belum ada/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('camera')).not.toBeInTheDocument();
  });
});

describe('EXPORT PDF / EXPORT EXCEL (FR-12, doc 05 §8.5)', () => {
  const LV1: Auth = { ...AUTH, username: 'ANDI CONTOH', level: 'PSI lv.1' };
  const FILE = /^M100_0903359388_\d{8}\.(pdf|xlsx)$/;

  beforeEach(() => {
    vi.mocked(exportFile).mockReset();
    vi.mocked(exportFile).mockImplementation((format, report) =>
      Promise.resolve({ name: `${report.fileBase}.${format}`, blob: new Blob([format]) }),
    );
    vi.mocked(saveFile).mockReset();
    vi.mocked(saveFile).mockResolvedValue('saved');
    vi.mocked(toJpeg).mockResolvedValue({ blob: new Blob(['jpeg']), sha256: 'hash' });
  });

  /** Everything the tablet stores, to show that an export leaves it as it was (AC-12.4). */
  const snapshot = async () =>
    JSON.stringify(await Promise.all(db.tables.map((table) => table.toArray())));

  async function asLv1() {
    await store.getState().logout();
    await store.getState().login(LV1);
  }

  it('makes each file, says its name, and changes nothing (AC-12.3, AC-12.4)', async () => {
    await asLv1();
    await store.getState().addPo(PO, null);
    await tap(PO.po, START_REWORK, defect(entry('MAJOR', 'A01')), END, { type: 'NO_DEFECT' });
    renderHome(LV1);
    const sessions = store.getState().sessions;
    const before = await snapshot();

    for (const [button, format] of [
      ['EXPORT PDF', 'pdf'],
      ['EXPORT EXCEL', 'xlsx'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: button }));
      await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(format === 'pdf' ? 1 : 2));
      const [usedFormat, report] = vi.mocked(exportFile).mock.lastCall!;
      expect(usedFormat).toBe(format);
      expect(report.results.find((r) => r.label === 'Qty Inspection')?.value).toBe(2);
      const name = vi.mocked(saveFile).mock.lastCall![0];
      expect(name).toMatch(FILE);
      expect(name.endsWith(`.${format}`)).toBe(true);
      expect(await screen.findByText(`File dibuat: ${name}`)).toBeInTheDocument();
    }

    expect(store.getState().sessions).toBe(sessions);
    expect(await snapshot()).toBe(before);
    expect(stat('Qty Inspection')).toBe('2');
  });

  it('exports an empty session (doc 05 §8.5)', async () => {
    await store.getState().addPo(PO, null);
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'EXPORT EXCEL' }));
    await waitFor(() => expect(saveFile).toHaveBeenCalledOnce());
    expect(vi.mocked(exportFile).mock.lastCall![1].defects).toEqual([]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('PSI lv.2 with a Top 5 photo missing: blocks both files and names the defects (BR-04)', async () => {
    const a = entry('MAJOR', 'A01');
    const b = entry('MINOR', 'A01');
    await store.getState().addPo(PO, null);
    await tap(PO.po, START_REWORK, defect(a), defect(a), defect(b));
    await act(() =>
      store.getState().savePhoto(PO.po, b.defectId, { blob: new Blob(['j']), sha256: 'h' }),
    );
    renderHome();
    const before = await snapshot();

    for (const button of ['EXPORT PDF', 'EXPORT EXCEL']) {
      fireEvent.click(screen.getByRole('button', { name: button }));
      const dialog = screen.getByRole('alertdialog', { name: 'Foto belum lengkap' });
      expect(dialog).toHaveTextContent(
        'PSI lv.2 wajib menambahkan foto pada Top 5 Defect. Belum ada foto untuk:',
      );
      expect(
        within(dialog)
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual([nameOf(a)]);
      // Must be answered: no close button, the scrim does not close it.
      expect(within(dialog).queryByRole('button', { name: /tutup/i })).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('scrim'));
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Lengkapi foto' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    }

    expect(exportFile).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
    expect(await snapshot()).toBe(before);
  });

  it('PSI lv.2 with every Top 5 photo exports', async () => {
    const a = entry('MAJOR', 'A01');
    await store.getState().addPo(PO, null);
    await tap(PO.po, START_REWORK, defect(a));
    await act(() =>
      store.getState().savePhoto(PO.po, a.defectId, { blob: new Blob(['j']), sha256: 'h' }),
    );
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'EXPORT PDF' }));
    await waitFor(() => expect(saveFile).toHaveBeenCalledOnce());
    expect(vi.mocked(exportFile).mock.lastCall![1].photos.map((p) => p.defectId)).toEqual([
      a.defectId,
    ]);
  });

  it('says nothing when the save dialog is closed', async () => {
    vi.mocked(saveFile).mockResolvedValue('cancelled');
    await store.getState().addPo(PO, null);
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'EXPORT PDF' }));
    await waitFor(() => expect(saveFile).toHaveBeenCalledOnce());
    await act(() => Promise.resolve());
    expect(screen.queryByText(/^File/)).not.toBeInTheDocument();
  });

  it('says so when the file cannot be made', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(saveFile).mockRejectedValue(new DOMException('full', 'QuotaExceededError'));
    await store.getState().addPo(PO, null);
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'EXPORT EXCEL' }));
    expect(await screen.findByText('File gagal dibuat. Coba lagi.')).toBeInTheDocument();
  });
});

describe('SUBMIT PO (FR-11, doc 05 §13)', () => {
  const LV1: Auth = { ...AUTH, username: 'ANDI CONTOH', level: 'PSI lv.1' };
  const jpeg = { blob: new Blob(['j'], { type: 'image/jpeg' }), sha256: 'h' };
  const NO_DEFECT: TapCommand = { type: 'NO_DEFECT' };
  const submit = () => fireEvent.click(screen.getByRole('button', { name: 'SUBMIT PO' }));
  const summary = (label: string) =>
    within(screen.getByRole('dialog', { name: 'Submit PO' }))
      .getByText(label)
      .closest('.m100-stat')
      ?.querySelector('b')?.textContent;

  /** Everything sealing touches. */
  async function stored() {
    return {
      sessions: (await db.sessions.toArray()).map((s) => [s.id, s.status]),
      events: await db.events.count(),
      photos: await db.photos.count(),
      outbox: await db.outbox.count(),
      outboxPhotos: await db.outboxPhotos.count(),
    };
  }

  it('blocks while an inspection is active; Ke ADD DEFECT opens the Defect screen', async () => {
    await store.getState().addPo(PO, null);
    await tap(PO.po, START_REWORK, defect(entry('MAJOR', 'A01')));
    renderHome();
    const before = await stored();
    submit();
    // The active inspection is checked first, before the photo check.
    const dialog = screen.getByRole('alertdialog', { name: 'Inspeksi masih berjalan' });
    expect(dialog).toHaveTextContent('Selesaikan inspeksi dulu (END INSPECTION).');
    // Must be answered: no close button, the scrim does not close it.
    expect(within(dialog).queryByRole('button', { name: /tutup/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('scrim'));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Ke ADD DEFECT' }));
    await waitFor(() => expect(store.getState().view.screen).toBe('defect'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await stored()).toEqual(before);
  });

  it('blocks when Qty Inspection is 0', async () => {
    await store.getState().addPo(PO, null);
    renderHome();
    submit();
    const dialog = screen.getByRole('alertdialog', { name: 'Belum ada inspeksi' });
    expect(dialog).toHaveTextContent('Belum ada inspeksi untuk PO ini. Mulai dari ADD DEFECT.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mengerti' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await db.outbox.count()).toBe(0);
  });

  it('lists the Top 5 defects without a photo for PSI lv.2 (BR-04)', async () => {
    const a = entry('MAJOR', 'A01');
    const b = entry('MINOR', 'A01');
    await store.getState().addPo(PO, null);
    await tap(PO.po, START_REWORK, defect(a), defect(b), defect(b), END);
    await act(() => store.getState().savePhoto(PO.po, a.defectId, jpeg));
    renderHome();
    submit();
    const dialog = screen.getByRole('alertdialog', { name: 'Foto belum lengkap' });
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([nameOf(b)]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lengkapi foto' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await db.outbox.count()).toBe(0);
  });

  it('confirms with the summary; BATAL, the close button and the scrim change nothing', async () => {
    const a = entry('MAJOR', 'A01');
    await store.getState().addPo(PO, { number: 1, qty: 1200 });
    await tap(PO.po, START_BGRADE, defect(a), END, NO_DEFECT, NO_DEFECT, NO_DEFECT);
    await act(() => store.getState().savePhoto(PO.po, a.defectId, jpeg));
    renderHome();
    const before = await stored();

    submit();
    expect(summary('PO')).toBe(PO.po);
    expect(summary('Partial')).toBe(formatPartial({ number: 1, qty: 1200 }, PO.orderQty));
    expect(summary('Qty Inspection')).toBe('4');
    expect(summary('Qty Defect')).toBe('1');
    expect(summary('Qty A-Grade')).toBe('3');
    expect(summary('Qty B-Grade')).toBe('1');
    expect(summary('Defect Rate')).toBe('25,0%');
    expect(summary('Pass Rate (RFT)')).toBe('75,0%');
    expect(summary('Foto')).toBe('1');

    const dialog = () => screen.queryByRole('dialog', { name: 'Submit PO' });
    fireEvent.click(within(dialog()!).getByRole('button', { name: 'BATAL' }));
    expect(dialog()).not.toBeInTheDocument();
    submit();
    fireEvent.click(within(dialog()!).getByRole('button', { name: 'Tutup' }));
    expect(dialog()).not.toBeInTheDocument();
    submit();
    fireEvent.click(screen.getByTestId('scrim'));
    expect(dialog()).not.toBeInTheDocument();
    expect(await stored()).toEqual(before);
  });

  it('KIRIM seals the session: Home shows zeros, the toast and the waiting count (AC-04.2, AC-11.3)', async () => {
    const a = entry('MAJOR', 'A01');
    await store.getState().addPo(PO, { number: 2, qty: 300 });
    await tap(PO.po, START_REWORK, defect(a), END);
    await act(() => store.getState().savePhoto(PO.po, a.defectId, jpeg));
    renderHome();
    expect(screen.queryByLabelText(/pengiriman menunggu/)).not.toBeInTheDocument();

    submit();
    fireEvent.click(screen.getByRole('button', { name: 'KIRIM' }));

    expect(await screen.findByText('Tersimpan. Menunggu koneksi.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('1 pengiriman menunggu')).toHaveTextContent('1');
    expect(stat('Qty Inspection')).toBe('0');
    expect(stat('Qty Defect')).toBe('0');
    expect(stat('Defect Rate')).toBe('—');
    expect(screen.getByText('Belum ada defect')).toBeInTheDocument();
    // U10: the partial stays on the PO.
    expect(infoValue('PARTIAL')).toBe(formatPartial({ number: 2, qty: 300 }, PO.orderQty));
    expect(await db.outbox.count()).toBe(1);
    expect(await db.outboxPhotos.count()).toBe(1);
  });

  describe('after KIRIM (doc 05 §13.3)', () => {
    function fakeSender(answer: Partial<OutboxRow> | undefined) {
      return {
        run: vi.fn(() => Promise.resolve()),
        start: vi.fn(() => Promise.resolve()),
        send: vi.fn(async (uuid: string) => {
          const item = await db.outbox.get(uuid);
          return item && answer ? { ...item, ...answer } : item;
        }),
      } satisfies OutboxSender;
    }

    async function kirim(sender: OutboxSender) {
      await store.getState().addPo(PO, null);
      await tap(PO.po, NO_DEFECT);
      render(
        <AppStoreContext.Provider value={store}>
          <OutboxSenderContext.Provider value={sender}>
            <ToastProvider>
              <HomeScreen auth={AUTH} />
            </ToastProvider>
          </OutboxSenderContext.Provider>
        </AppStoreContext.Provider>,
      );
      submit();
      fireEvent.click(screen.getByRole('button', { name: 'KIRIM' }));
    }

    it('online: "Sedang dikirim.", then "PO terkirim HH:mm" in WIB when the API stored it', async () => {
      let answer: (value: OutboxRow | undefined) => void = () => undefined;
      const sender = fakeSender(undefined);
      sender.send.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
      await kirim(sender);
      expect(await screen.findByText('Sedang dikirim.')).toBeInTheDocument();
      // Home does not wait for the answer: the next round can start (doc 05 §13.3).
      expect(stat('Qty Inspection')).toBe('0');
      const [item] = await db.outbox.toArray();
      expect(sender.send).toHaveBeenCalledWith(item!.submissionUuid);
      await act(async () => {
        answer({ ...item!, state: 'sent', sentAt: '2026-10-16T07:32:40.000Z' });
        await Promise.resolve();
      });
      expect(await screen.findByText('PO terkirim 14:32')).toBeInTheDocument();
    });

    it('online without an answer: "Tersimpan. Menunggu koneksi."', async () => {
      await kirim(fakeSender({ state: 'waiting', attempts: 1 }));
      expect(await screen.findByText('Tersimpan. Menunggu koneksi.')).toBeInTheDocument();
    });

    it('refused: no waiting toast here; the Gagal toast comes from the outbox watcher', async () => {
      await kirim(fakeSender({ state: 'failed', problem: 'x' }));
      expect(await screen.findByText('Sedang dikirim.')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText('Tersimpan. Menunggu koneksi.')).toBeNull());
    });

    it('offline: "Tersimpan. Menunggu koneksi." at once, nothing is sent', async () => {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      const sender = fakeSender(undefined);
      await kirim(sender);
      expect(await screen.findByText('Tersimpan. Menunggu koneksi.')).toBeInTheDocument();
      expect(sender.send).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });
  });

  it('PSI lv.1 confirms without a Foto row and submits no photo (AC-10.6)', async () => {
    await act(async () => {
      await store.getState().logout();
      await store.getState().login(LV1);
    });
    await store.getState().addPo(PO, null);
    await tap(PO.po, START_REWORK, defect(entry('MAJOR', 'A01')), END);
    renderHome(LV1);
    submit();
    expect(screen.queryByText('Foto')).not.toBeInTheDocument();
    expect(screen.queryByText('Partial')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'KIRIM' }));
    expect(await screen.findByText('Tersimpan. Menunggu koneksi.')).toBeInTheDocument();
    expect(await db.outbox.count()).toBe(1);
    expect(await db.outboxPhotos.count()).toBe(0);
  });

  it('says so when sealing fails on the tablet, and keeps the session', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await store.getState().addPo(PO, null);
    await tap(PO.po, NO_DEFECT);
    renderHome();
    const before = await stored();
    vi.spyOn(db.outbox, 'add').mockRejectedValueOnce(new Error('QuotaExceededError'));

    submit();
    fireEvent.click(screen.getByRole('button', { name: 'KIRIM' }));

    expect(await screen.findByText('PO gagal disimpan. Coba lagi.')).toBeInTheDocument();
    expect(stat('Qty Inspection')).toBe('1');
    expect(await stored()).toEqual(before);
    expect(screen.queryByLabelText(/pengiriman menunggu/)).not.toBeInTheDocument();
  });
});
