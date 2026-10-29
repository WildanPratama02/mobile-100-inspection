import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { defaultMapping } from '@m100/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../app/toast';
import { ALL_PO_MASTER } from '../data/fixtures/pos';
import { createDb, type Auth, type M100Db } from '../db/schema';
import { AppStoreContext, createAppStore, type AppStore } from '../state/store';
import { HomeScreen } from './HomeScreen';

const AUTH: Auth = {
  username: 'PSI TEST',
  level: 'PSI lv.1',
  factory: 'F 3',
  cell: 'F3-10',
  token: null,
  tokenExpiresAt: null,
};
const PO = ALL_PO_MASTER.find((p) => p.po === '0903359388')!;
const OTHER = ALL_PO_MASTER.find((p) => p.po === 'CX-0902368685')!;
const ENTRY = defaultMapping().map[0]!;
let db: M100Db;
let store: AppStore;
beforeEach(async () => {
  db = createDb(`qty-${crypto.randomUUID()}`);
  store = createAppStore(db);
  await store.getState().hydrate();
  await store.getState().login(AUTH);
  await store.getState().addPo(PO, { number: 1, qty: 30 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
});
function home() {
  render(
    <AppStoreContext.Provider value={store}>
      <ToastProvider>
        <HomeScreen auth={AUTH} />
      </ToastProvider>
    </AppStoreContext.Provider>,
  );
}
const edit = () => fireEvent.click(screen.getByRole('button', { name: 'Ubah Qty Inspection' }));
const dialog = () => screen.getByRole('dialog', { name: 'QTY INSPECTION' });
function enter(qty: number) {
  const d = within(dialog());
  fireEvent.click(d.getByRole('button', { name: 'HAPUS' }));
  for (const digit of String(qty)) fireEvent.click(d.getByRole('button', { name: digit }));
}
const save = () => within(dialog()).getByRole('button', { name: 'SIMPAN' });
async function setQty(qty: number) {
  await act(() => store.getState().tap(PO.po, { type: 'SET_QTY_INSPECTION', qty }));
}
async function defects(n: number) {
  await act(async () => {
    await store.getState().tap(PO.po, { type: 'START', inspection: 'B-GRADE' });
    for (let i = 0; i < n; i++) await store.getState().tap(PO.po, { type: 'DEFECT', entry: ENTRY });
    await store.getState().tap(PO.po, { type: 'END' });
  });
}
const value = (label: string) =>
  within(screen.getByRole('region', { name: 'Hasil' }))
    .getByText(label)
    .closest('.m100-stat')!
    .querySelector('b')!.textContent;

it('accepts an all-good session with manual Qty Inspection and no findings', async () => {
  await setQty(10);
  home();
  expect(value('Qty A-Grade')).toBe('10');
  expect(value('Pass Rate (RFT)')).toBe('100,0%');
  fireEvent.click(screen.getByRole('button', { name: 'SUBMIT PO' }));
  expect(screen.getByRole('dialog', { name: 'Submit PO' })).toBeVisible();
});

it('validates the pad minimum and partial maximum, then persists before closing', async () => {
  await defects(3);
  home();
  edit();
  expect(save()).toBeDisabled();
  enter(2);
  expect(save()).toBeDisabled();
  expect(within(dialog()).getByText('Minimal 3 pasang')).toBeVisible();
  enter(31);
  expect(save()).toBeDisabled();
  expect(within(dialog()).getByText('Maksimum 30 pasang')).toBeVisible();
  enter(30);
  fireEvent.click(save());
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(await db.events.filter((e) => e.type === 'SET_QTY_INSPECTION').count()).toBe(1);
  const reopened = createAppStore(db);
  await reopened.getState().hydrate();
  expect(reopened.getState().sessions[PO.po]!.state.qtyInspection).toBe(30);
  expect(value('Qty A-Grade')).toBe('27');
  expect(value('Pass Rate (RFT)')).toBe('90,0%');
});

it.each(['BATAL', 'Escape', 'scrim', 'close'])(
  'cancelling with %s writes nothing',
  async (method) => {
    await setQty(10);
    home();
    edit();
    enter(20);
    if (method === 'BATAL')
      fireEvent.click(within(dialog()).getByRole('button', { name: 'BATAL' }));
    else if (method === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
    else if (method === 'scrim') fireEvent.click(screen.getByTestId('scrim'));
    else fireEvent.click(within(dialog()).getByRole('button', { name: /tutup/i }));
    expect(store.getState().sessions[PO.po]!.state.qtyInspection).toBe(10);
    expect(await db.events.filter((e) => e.type === 'SET_QTY_INSPECTION').count()).toBe(1);
  },
);

it('keeps quantities separate for each PO', async () => {
  await setQty(10);
  await store.getState().addPo(OTHER, null);
  expect(store.getState().sessions[OTHER.po]!.state.qtyInspection).toBeNull();
  await store.getState().tap(OTHER.po, { type: 'SET_QTY_INSPECTION', qty: 20 });
  expect(store.getState().sessions[PO.po]!.state.qtyInspection).toBe(10);
});

it('keeps the editor open and shows an error when persistence fails', async () => {
  vi.spyOn(store.getState(), 'tap').mockRejectedValueOnce(new Error('disk full'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  home();
  edit();
  enter(10);
  fireEvent.click(save());
  expect(await screen.findByText('Qty Inspection gagal disimpan. Coba lagi.')).toBeVisible();
  expect(dialog()).toBeVisible();
  expect(store.getState().sessions[PO.po]!.state.qtyInspection).toBeNull();
});

it('allows editing during an active inspection and preserves the undo history', async () => {
  await store.getState().tap(PO.po, { type: 'START', inspection: 'REWORK' });
  home();
  edit();
  enter(10);
  fireEvent.click(save());
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(store.getState().sessions[PO.po]!.state.undo).toBe('INSPECTION');
  await act(() => store.getState().tap(PO.po, { type: 'UNDO' }));
  expect(store.getState().sessions[PO.po]!.state.qtyInspection).toBe(10);
});

it('keeps an entered value after more findings make it too small and opens the submit correction', async () => {
  await setQty(1);
  await defects(2);
  home();
  expect(value('Qty Inspection')).toBe('1');
  expect(value('Qty A-Grade')).toBe('0');
  expect(value('Qty B-Grade')).toBe('2');
  expect(value('Defect Rate')).toBe('0,0%');
  expect(
    screen.getByText('QTY INSPECTION kurang dari 2 defect yang tercatat. Ubah sebelum SUBMIT PO.'),
  ).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'SUBMIT PO' }));
  expect(screen.getByRole('alertdialog', { name: 'QTY INSPECTION kurang' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Ubah QTY INSPECTION' }));
  expect(dialog()).toBeVisible();
});

it('detects a quantity above a newly reduced partial and offers correction', async () => {
  await setQty(30);
  await store.getState().setPartial(PO.po, { number: 1, qty: 20 });
  home();
  expect(value('Qty Inspection')).toBe('30');
  expect(value('Qty A-Grade')).toBe('0');
  expect(value('Pass Rate (RFT)')).toBe('0,0%');
  fireEvent.click(screen.getByRole('button', { name: 'SUBMIT PO' }));
  expect(screen.getByRole('alertdialog', { name: 'QTY INSPECTION terlalu besar' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Ubah QTY INSPECTION' }));
  expect(dialog()).toBeVisible();
});

it.each([null, 2])(
  'blocks impossible partial limits with quantity %s before sealing an outbox',
  async (qty) => {
    if (qty !== null) await setQty(qty);
    await defects(3);
    await store.getState().setPartial(PO.po, { number: 1, qty: 2 });
    home();
    expect(screen.getByText(/3 defect tercatat, melebihi partial 2 pasang/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'SUBMIT PO' }));
    // IMPOSSIBLE before EMPTY (doc 05 §13.1): no value could be valid, so entering one would not help.
    expect(
      screen.getByRole('alertdialog', { name: 'Defect melebihi jumlah pasang' }),
    ).toBeVisible();
    expect(screen.queryByRole('alertdialog', { name: 'QTY INSPECTION belum diisi' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mengerti' }));
    await expect(store.getState().submitPo(PO.po, defaultMapping())).rejects.toThrow();
    expect(await db.outbox.count()).toBe(0);
    edit();
    enter(3);
    expect(save()).toBeDisabled();
    expect(
      within(dialog()).getByText(/Jumlah defect \(3\) melebihi partial 2 pasang/),
    ).toBeVisible();
    expect(store.getState().sessions[PO.po]!.state.recorded).toHaveLength(3);
  },
);
