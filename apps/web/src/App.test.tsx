import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Po } from '@m100/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createFixtureSources } from './data/fixtures/fixtureSources';
import type { DataSources } from './data/sources';
import { createDb, type M100Db } from './db/schema';
import { createAppStore, type AppStore } from './state/store';

const PO: Po = {
  po: '0903359388',
  article: 'ART-001',
  model: 'MODEL UJI',
  destination: 'XX',
  orderQty: 1200,
  podd: null,
  crd: null,
};

let name: string;
let connections: M100Db[];

beforeEach(() => {
  name = `app-${crypto.randomUUID()}`;
  connections = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  connections.forEach((c) => c.close());
  await createDb(name).delete();
  vi.restoreAllMocks();
});

/** A fresh store on this test's database, as when the app is opened (again). */
function openStore(): AppStore {
  const db = createDb(name);
  connections.push(db);
  return createAppStore(db);
}

function openApp(sources: DataSources = createFixtureSources(), store = openStore()) {
  const { unmount } = render(<App store={store} sources={sources} />);
  return { store, close: unmount };
}

function pick(field: 'Nama' | 'Factory' | 'Cell', option: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${field}`) }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('option', { name: new RegExp(`^${option}`) }));
}

async function loginAs(username: string, cell = 'F3-10') {
  await screen.findByRole('heading', { name: 'Login PSI' });
  pick('Nama', username);
  pick('Factory', 'F 3');
  pick('Cell', cell);
  fireEvent.click(screen.getByRole('button', { name: 'LOGIN' }));
  await screen.findByRole('button', { name: 'Pengaturan' });
}

function logoutViaMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Pengaturan' }));
  fireEvent.click(
    within(screen.getByRole('dialog', { name: 'Pengaturan' })).getByRole('button', {
      name: 'LOGOUT',
    }),
  );
}

describe('start (AC-01.4)', () => {
  it('says the data could not be loaded and offers RETRY, never an empty name list', async () => {
    let fail = true;
    const fixtures = createFixtureSources();
    const sources: DataSources = {
      ...fixtures,
      masterData: {
        getLoginData: () =>
          fail ? Promise.reject(new Error('offline')) : fixtures.masterData.getLoginData(),
      },
    };
    openApp(sources);

    expect(
      await screen.findByText('Data awal belum bisa diunduh. Periksa Wi-Fi, lalu tekan RETRY.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Nama/ })).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'RETRY' }));
    expect(await screen.findByRole('heading', { name: 'Login PSI' })).toBeInTheDocument();
  });

  it('starts from the cached copy when the source fails later', async () => {
    const first = openApp();
    await screen.findByRole('heading', { name: 'Login PSI' });
    first.close();

    const down: DataSources = {
      ...createFixtureSources(),
      masterData: { getLoginData: () => Promise.reject(new Error('offline')) },
    };
    openApp(down);
    expect(await screen.findByRole('heading', { name: 'Login PSI' })).toBeInTheDocument();
  });
});

describe('login (FR-01)', () => {
  it('lists only PSI names, each with its level (AC-01.1)', async () => {
    openApp();
    await screen.findByRole('heading', { name: 'Login PSI' });
    fireEvent.click(screen.getByRole('button', { name: /^Nama/ }));
    const options = within(screen.getByRole('dialog', { name: 'Pilih nama' })).getAllByRole(
      'option',
    );
    expect(options.map((o) => o.textContent)).toEqual([
      'ANDI CONTOHPSI lv.1',
      'BUNGA CONTOHPSI lv.1',
      'CAHYA CONTOHPSI lv.1',
      'DEWI CONTOHPSI lv.2',
      'EKO CONTOHPSI lv.2',
      'FAJAR CONTOHPSI lv.2',
    ]);
  });

  it('shows the name and level in the header and the cell code in the info strip (AC-01.2)', async () => {
    openApp();
    await loginAs('DEWI CONTOH');
    const account = screen.getByLabelText('Akun');
    expect(account).toHaveTextContent('DEWI CONTOH');
    expect(account).toHaveTextContent('PSI lv.2');
    const info = screen.getByLabelText('Info PO');
    expect(within(info).getByText('FACTORY/CELL').nextSibling).toHaveTextContent('F3-10');
  });

  it('stays logged in after the app is closed and reopened (AC-01.3)', async () => {
    const first = openApp();
    await loginAs('ANDI CONTOH', 'F3-11');
    first.close();

    openApp();
    expect(await screen.findByLabelText('Akun')).toHaveTextContent('ANDI CONTOH');
    expect(screen.getByLabelText('Info PO')).toHaveTextContent('F3-11');
  });
});

describe('logout (FR-02)', () => {
  it('shows the account in the menu and returns to an empty login form (AC-02.1, U5)', async () => {
    openApp();
    await loginAs('DEWI CONTOH');
    fireEvent.click(screen.getByRole('button', { name: 'Pengaturan' }));
    const menu = screen.getByRole('dialog', { name: 'Pengaturan' });
    expect(menu).toHaveTextContent('DEWI CONTOH');
    expect(menu).toHaveTextContent('PSI lv.2');
    expect(menu).toHaveTextContent('Factory/Cell F3-10');

    fireEvent.click(within(menu).getByRole('button', { name: 'LOGOUT' }));
    expect(await screen.findByRole('heading', { name: 'Login PSI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Nama/ })).toHaveTextContent('Pilih nama');
    expect(screen.getByRole('button', { name: 'LOGIN' })).toBeDisabled();
  });

  it('warns about unsubmitted POs; BATAL stays, LOGOUT leaves (AC-02.2)', async () => {
    const { store } = openApp();
    await loginAs('DEWI CONTOH');
    await act(async () => {
      await store.getState().addPo(PO, null);
      await store.getState().addPo({ ...PO, po: 'CX-0902368685' }, null);
      await store.getState().tap(PO.po, { type: 'START', inspection: 'REWORK' });
      await store.getState().tap('CX-0902368685', { type: 'NO_DEFECT' });
    });

    logoutViaMenu();
    const warning = screen.getByRole('alertdialog', { name: 'Keluar?' });
    expect(warning).toHaveTextContent(
      '2 PO belum disubmit. Data tetap tersimpan di tablet ini untuk DEWI CONTOH.',
    );
    expect(within(warning).queryByRole('button', { name: 'Tutup' })).not.toBeInTheDocument();
    // Must be answered: the scrim does not close it.
    fireEvent.click(screen.getByTestId('scrim'));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    fireEvent.click(within(warning).getByRole('button', { name: 'BATAL' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Akun')).toHaveTextContent('DEWI CONTOH');

    logoutViaMenu();
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'LOGOUT' }),
    );
    expect(await screen.findByRole('heading', { name: 'Login PSI' })).toBeInTheDocument();
  });

  it('logs out at once when no PO has recorded data', async () => {
    const { store } = openApp();
    await loginAs('DEWI CONTOH');
    await act(() => store.getState().addPo(PO, null));
    logoutViaMenu();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Login PSI' })).toBeInTheDocument();
  });

  it('keeps sessions with their author and away from other PSI (AC-02.3)', async () => {
    const { store } = openApp();
    await loginAs('DEWI CONTOH');
    await act(async () => {
      await store.getState().addPo(PO, null);
      await store.getState().tap(PO.po, { type: 'START', inspection: 'B-GRADE' });
    });
    logoutViaMenu();
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'LOGOUT' }),
    );

    await loginAs('EKO CONTOH');
    expect(store.getState().pos).toEqual([]);
    expect(store.getState().sessions).toEqual({});
    logoutViaMenu();

    await loginAs('DEWI CONTOH');
    expect(store.getState().pos.map((p) => p.po)).toEqual([PO.po]);
    expect(store.getState().sessions[PO.po]?.events).toHaveLength(1);
  });
});
