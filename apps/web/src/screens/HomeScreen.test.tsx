import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { defaultMapping, type AreaMapEntry, type Classification, type Po } from '@m100/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_PO_MASTER } from '../data/fixtures/pos';
import { createDb, type Auth, type M100Db } from '../db/schema';
import { AppStoreContext, createAppStore, type AppStore, type TapCommand } from '../state/store';
import { HomeScreen, LONG_PRESS_MS } from './HomeScreen';

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

function renderHome() {
  render(
    <AppStoreContext.Provider value={store}>
      <HomeScreen auth={AUTH} />
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
    // The photo control comes with T1.5.
    expect(row?.querySelector('.m100-t5--nophoto')).not.toBeNull();
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
