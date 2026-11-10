import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { defaultMapping } from '@m100/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../app/toast';
import { ALL_PO_MASTER } from '../data/fixtures/pos';
import { createDb, type Auth, type M100Db } from '../db/schema';
import { AppStoreContext, createAppStore, type AppStore, type TapCommand } from '../state/store';
import { HomeScreen } from './HomeScreen';

// S5c (doc 05 §10c) opened from the Home results row, as the PSI uses it.
const AUTH: Auth = {
  username: 'PSI TEST',
  level: 'PSI lv.2',
  factory: 'F 3',
  cell: 'F3-10',
  token: null,
  tokenExpiresAt: null,
};
const PO = ALL_PO_MASTER.find((p) => p.po === '0903359388')!;
const ENTRY = defaultMapping().map[0]!;
let db: M100Db;
let store: AppStore;

beforeEach(async () => {
  db = createDb(`rework-${crypto.randomUUID()}`);
  store = createAppStore(db);
  await store.getState().hydrate();
  await store.getState().login(AUTH);
  await store.getState().addPo(PO, null);
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

async function tap(...commands: TapCommand[]) {
  await act(async () => {
    for (const command of commands) {
      expect(await store.getState().tap(PO.po, command)).not.toBeNull();
    }
  });
}

/** `n` REWORK inspections, each with one defect, ended. */
const reworks = (n: number): TapCommand[] =>
  Array.from({ length: n }, () => [
    { type: 'START', inspection: 'REWORK' } as const,
    { type: 'DEFECT', entry: ENTRY } as const,
    { type: 'END' } as const,
  ]).flat();

const open = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Ubah REWORK AND APPROVED' }));
const dialog = () => screen.getByRole('dialog', { name: 'REWORK AND APPROVED' });
const queryDialog = () => screen.queryByRole('dialog', { name: 'REWORK AND APPROVED' });
function enter(digits: string) {
  const d = within(dialog());
  fireEvent.click(d.getByRole('button', { name: 'HAPUS' }));
  for (const digit of digits) fireEvent.click(d.getByRole('button', { name: digit }));
}
const save = () => within(dialog()).getByRole('button', { name: 'SIMPAN' });
const approved = () => store.getState().sessions[PO.po]!.state.reworkApproved;
const value = () =>
  within(screen.getByRole('region', { name: 'Hasil' }))
    .getByText('REWORK AND APPROVED')
    .closest('.m100-stat')!
    .querySelector('b')!.textContent;
const storedEvents = () => db.events.filter((e) => e.type === 'SET_REWORK_APPROVED').toArray();

it('shows the helper with the maximum, refuses above it, and saves within 0…max', async () => {
  await tap(...reworks(3));
  home();
  open();
  expect(dialog()).toHaveTextContent(
    'Pasang rework yang sudah diperbaiki dan lolos inspeksi ulang (maks. 3)',
  );
  // Empty the first time; empty is allowed.
  expect(within(dialog()).getByRole('status')).toHaveTextContent('0PASANG');
  expect(save()).toBeEnabled();
  enter('4');
  expect(dialog()).toHaveTextContent('Maksimum 3 pasang');
  expect(save()).toBeDisabled();
  enter('2');
  expect(save()).toBeEnabled();
  fireEvent.click(save());
  await waitFor(() => expect(queryDialog()).not.toBeInTheDocument());
  expect(approved()).toBe(2);
  expect(value()).toContain('2');
  expect((await storedEvents()).map((e) => e.type === 'SET_REWORK_APPROVED' && e.qty)).toEqual([2]);
});

it('opens pre-filled, saves empty (sent as 0) and 0, and BATAL changes nothing', async () => {
  await tap(...reworks(2), { type: 'SET_REWORK_APPROVED', qty: 2 });
  home();
  open();
  expect(within(dialog()).getByRole('status')).toHaveTextContent('2PASANG');
  enter('1');
  fireEvent.click(within(dialog()).getByRole('button', { name: 'BATAL' }));
  expect(queryDialog()).not.toBeInTheDocument();
  expect(approved()).toBe(2);

  open();
  fireEvent.click(within(dialog()).getByRole('button', { name: 'HAPUS' }));
  fireEvent.click(save());
  await waitFor(() => expect(queryDialog()).not.toBeInTheDocument());
  expect(approved()).toBeNull();
  expect(value()).toContain('—');

  open();
  enter('0');
  fireEvent.click(save());
  await waitFor(() => expect(queryDialog()).not.toBeInTheDocument());
  expect(approved()).toBe(0);
  expect(value()).toContain('0');
});

it('after UNDO to 0 rework opens with max 0, so the PSI can save 0 and the row turns disabled', async () => {
  await tap(
    { type: 'NO_DEFECT' },
    { type: 'START', inspection: 'REWORK' },
    { type: 'SET_REWORK_APPROVED', qty: 1 },
    { type: 'UNDO' },
  );
  home();
  open();
  expect(dialog()).toHaveTextContent('(maks. 0)');
  // The saved value is kept and shown; it cannot be saved as it is.
  expect(within(dialog()).getByRole('status')).toHaveTextContent('1PASANG');
  expect(dialog()).toHaveTextContent('Maksimum 0 pasang');
  expect(save()).toBeDisabled();
  enter('0');
  fireEvent.click(save());
  await waitFor(() => expect(queryDialog()).not.toBeInTheDocument());
  expect(approved()).toBe(0);
  expect(screen.queryByRole('button', { name: 'Ubah REWORK AND APPROVED' })).toBeNull();
  expect(screen.getByText('Belum ada inspeksi REWORK.')).toBeInTheDocument();
});

it('stays open and changes nothing when the tablet cannot store the value (NFR-05)', async () => {
  await tap(...reworks(1));
  home();
  vi.spyOn(db.events, 'add').mockRejectedValueOnce(new Error('disk full'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  open();
  enter('1');
  fireEvent.click(save());
  expect(
    await within(dialog()).findByText('REWORK AND APPROVED gagal disimpan. Coba lagi.'),
  ).toBeInTheDocument();
  expect(approved()).toBeNull();
  expect(value()).toContain('—');
  expect(await storedEvents()).toEqual([]);
});
