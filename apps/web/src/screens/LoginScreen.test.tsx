import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataSourcesContext } from '../app/dataSources';
import { createFixtureSources, fixtureMasterData } from '../data/fixtures/fixtureSources';
import {
  ApiError,
  LoginRejectedError,
  OfflineError,
  type DataSources,
  type MasterData,
} from '../data/sources';
import { createDb, type M100Db } from '../db/schema';
import { AppStoreContext, createAppStore, type AppStore } from '../state/store';
import { LoginScreen } from './LoginScreen';

let db: M100Db;
let store: AppStore;
let data: MasterData;

beforeEach(async () => {
  db = createDb(`login-${crypto.randomUUID()}`);
  store = createAppStore(db);
  await store.getState().hydrate();
  data = fixtureMasterData();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
});

function renderLogin(sources: DataSources = createFixtureSources()) {
  render(
    <DataSourcesContext.Provider value={sources}>
      <AppStoreContext.Provider value={store}>
        <LoginScreen data={data} />
      </AppStoreContext.Provider>
    </DataSourcesContext.Provider>,
  );
}

const field = (label: 'Nama' | 'Factory' | 'Cell') =>
  screen.getByRole('button', { name: new RegExp(`^${label}`) });

function pick(label: 'Nama' | 'Factory' | 'Cell', option: string) {
  fireEvent.click(field(label));
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('option', { name: new RegExp(`^${option}`) }),
  );
}

const loginButton = () => screen.getByRole('button', { name: 'LOGIN' });
const HINT = 'Pilih nama, factory, dan cell.';

describe('LoginScreen (doc 05 §7)', () => {
  it('enables LOGIN only when name, factory and cell are chosen, with a hint until then', () => {
    renderLogin();
    expect(loginButton()).toBeDisabled();
    expect(screen.getByText(HINT)).toBeInTheDocument();

    pick('Nama', 'DEWI CONTOH');
    expect(loginButton()).toBeDisabled();
    pick('Factory', 'F 3');
    expect(loginButton()).toBeDisabled();
    pick('Cell', 'F3-12');

    expect(loginButton()).toBeEnabled();
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    expect(field('Cell')).toHaveTextContent('F3-12');
  });

  it('shows the chosen name with its level', () => {
    renderLogin();
    pick('Nama', 'ANDI CONTOH');
    expect(field('Nama')).toHaveTextContent('ANDI CONTOH');
    expect(screen.getByText('PSI lv.1')).toBeInTheDocument();
  });

  it('keeps Cell disabled until a factory is chosen', () => {
    renderLogin();
    expect(field('Cell')).toBeDisabled();
  });

  it('selects the only cell of a factory by itself (FR-01.3)', () => {
    renderLogin();
    pick('Factory', 'F 1');
    expect(field('Cell')).toHaveTextContent('F1-01');
  });

  it('clears the cell when the factory changes', () => {
    renderLogin();
    pick('Factory', 'F 3');
    pick('Cell', 'F3-10');
    pick('Factory', 'F 1');
    expect(field('Cell')).toHaveTextContent('F1-01');
    pick('Factory', 'F 3');
    expect(field('Cell')).toHaveTextContent('Pilih cell');
  });

  it('marks the chosen option in a picker and closes on Escape and scrim tap', () => {
    renderLogin();
    pick('Factory', 'F 3');
    fireEvent.click(field('Factory'));
    expect(screen.getByRole('option', { name: 'F 3' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'F 1' })).toHaveAttribute('aria-selected', 'false');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(field('Nama'));
    fireEvent.click(screen.getByTestId('scrim'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('disables LOGIN while offline and says why (U4)', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderLogin();
    pick('Nama', 'DEWI CONTOH');
    pick('Factory', 'F 1');
    expect(
      screen.getByText('Login butuh koneksi. Hubungkan Wi-Fi, lalu coba lagi.'),
    ).toBeInTheDocument();
    expect(loginButton()).toBeDisabled();

    onLine.mockReturnValue(true);
    fireEvent(window, new Event('online'));
    expect(screen.queryByText(/Login butuh koneksi/)).not.toBeInTheDocument();
    expect(loginButton()).toBeEnabled();
  });

  it("shows the API's detail when the login is refused", async () => {
    const fixtures = createFixtureSources();
    renderLogin({
      ...fixtures,
      auth: {
        ...fixtures.auth,
        login: () =>
          Promise.reject(new LoginRejectedError('USER_NOT_FOUND', 'Nama tidak ada di daftar PSI.')),
      },
    });
    pick('Nama', 'DEWI CONTOH');
    pick('Factory', 'F 1');
    fireEvent.click(loginButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Nama tidak ada di daftar PSI.');
    expect(store.getState().auth).toBeNull();
  });

  it("shows any other refusal's detail, e.g. a revoked tablet", async () => {
    const fixtures = createFixtureSources();
    renderLogin({
      ...fixtures,
      auth: {
        ...fixtures.auth,
        login: () =>
          Promise.reject(
            new ApiError(401, 'DEVICE_KEY_INVALID', 'Tablet belum terdaftar. Hubungi admin.'),
          ),
      },
    });
    pick('Nama', 'DEWI CONTOH');
    pick('Factory', 'F 1');
    fireEvent.click(loginButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Tablet belum terdaftar. Hubungi admin.',
    );
  });

  it('says login needs a connection when the API does not answer, and LOGIN can be tried again', async () => {
    const fixtures = createFixtureSources();
    renderLogin({
      ...fixtures,
      auth: { ...fixtures.auth, login: () => Promise.reject(new OfflineError()) },
    });
    pick('Nama', 'DEWI CONTOH');
    pick('Factory', 'F 1');
    fireEvent.click(loginButton());
    expect(
      await screen.findByText('Login butuh koneksi. Hubungkan Wi-Fi, lalu coba lagi.'),
    ).toBeInTheDocument();
    expect(loginButton()).toBeEnabled();
  });

  it('logs in with what was chosen', async () => {
    const fixtures = createFixtureSources();
    const login = vi.spyOn(fixtures.auth, 'login');
    renderLogin(fixtures);
    pick('Nama', 'FAJAR CONTOH');
    pick('Factory', 'F 3');
    pick('Cell', 'F3-11');
    fireEvent.click(loginButton());
    await vi.waitFor(() => expect(store.getState().auth?.username).toBe('FAJAR CONTOH'));
    expect(login).toHaveBeenCalledWith({
      username: 'FAJAR CONTOH',
      level: 'PSI lv.2',
      factory: 'F 3',
      cell: 'F3-11',
    });
  });
});
