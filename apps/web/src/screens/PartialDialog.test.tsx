import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_PO_MASTER } from '../data/fixtures/pos';
import { createDb, type Auth, type M100Db } from '../db/schema';
import { AppStoreContext, createAppStore, type AppStore } from '../state/store';
import { PartialDialog } from './PartialDialog';

const AUTH: Auth = {
  username: 'DEWI CONTOH',
  level: 'PSI lv.2',
  factory: 'F 3',
  cell: 'F3-10',
  token: null,
  tokenExpiresAt: null,
};
const PO = ALL_PO_MASTER[0]!;

let db: M100Db;
let store: AppStore;
let onClose: () => void;

beforeEach(async () => {
  db = createDb(`partial-${crypto.randomUUID()}`);
  store = createAppStore(db);
  await store.getState().hydrate();
  await store.getState().login(AUTH);
  onClose = vi.fn();
});

afterEach(async () => {
  await db.delete();
});

function renderDialog() {
  const row = store.getState().pos[0]!;
  render(
    <AppStoreContext.Provider value={store}>
      <PartialDialog po={row} onClose={onClose} />
    </AppStoreContext.Provider>,
  );
}

const save = () => screen.getByRole('button', { name: 'SIMPAN' });
const box = () => screen.getByRole('checkbox', { name: /PO PARTIAL/ });
const stored = () => store.getState().pos[0]?.partial;

function pad(key: string) {
  const keys = screen.getByRole('group', { name: 'Qty partial' });
  fireEvent.click(within(keys).getByRole('button', { name: key }));
}

describe('S5 Partial (doc 05 §10)', () => {
  it('opens with the current partial and saves a change', async () => {
    await store.getState().addPo(PO, { number: 1, qty: 1200 });
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'PO Partial' })).toBeInTheDocument();
    expect(box()).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('P1')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Qty partial' })).toHaveTextContent('1.200');

    fireEvent.click(screen.getByRole('button', { name: 'Tambah' }));
    pad('Hapus satu angka');
    fireEvent.click(save());
    await waitFor(() => expect(stored()).toEqual({ number: 2, qty: 120 }));
    expect(onClose).toHaveBeenCalled();
  });

  it('removes the partial when unticked and saved (U9)', async () => {
    await store.getState().addPo(PO, { number: 3, qty: 50 });
    renderDialog();
    fireEvent.click(box());
    fireEvent.click(save());
    await waitFor(() => expect(stored()).toBeNull());
  });

  it('opens empty for a PO without a partial and adds one', async () => {
    await store.getState().addPo(PO, null);
    renderDialog();
    expect(box()).toHaveAttribute('aria-checked', 'false');
    expect(save()).toBeEnabled();
    fireEvent.click(box());
    expect(save()).toBeDisabled();
    pad('9');
    fireEvent.click(save());
    await waitFor(() => expect(stored()).toEqual({ number: 1, qty: 9 }));
  });

  it('disables SIMPAN for a quantity above Qty Order, and BATAL changes nothing', async () => {
    await store.getState().addPo({ ...PO, orderQty: 100 }, { number: 1, qty: 10 });
    renderDialog();
    pad('1');
    expect(screen.getByText('Maksimum 100 pasang')).toBeInTheDocument();
    expect(save()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'BATAL' }));
    expect(onClose).toHaveBeenCalled();
    expect(stored()).toEqual({ number: 1, qty: 10 });
  });
});
