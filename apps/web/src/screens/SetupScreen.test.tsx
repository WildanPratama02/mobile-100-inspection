import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataSourcesContext } from '../app/dataSources';
import { createFixtureSources } from '../data/fixtures/fixtureSources';
import { ApiError, OfflineError, type DataSources } from '../data/sources';
import * as repo from '../db/repo';
import { createDb, type M100Db } from '../db/schema';
import { AppStoreContext, createAppStore, type AppStore } from '../state/store';
import { keyFromHash } from '../app/setupLink';
import { SetupScreen } from './SetupScreen';

let db: M100Db;
let store: AppStore;

beforeEach(() => {
  db = createDb(`setup-${crypto.randomUUID()}`);
  store = createAppStore(db);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  await db.delete();
});

function openSetup(url: string, check: DataSources['system']['check']) {
  window.history.replaceState(null, '', url);
  const sources = { ...createFixtureSources(), system: { check } };
  render(
    <DataSourcesContext.Provider value={sources}>
      <AppStoreContext.Provider value={store}>
        <SetupScreen />
      </AppStoreContext.Provider>
    </DataSourcesContext.Provider>,
  );
  // As `App` does on every start.
  void store.getState().hydrate();
}

describe('keyFromHash', () => {
  it('reads k from the fragment', () => {
    expect(keyFromHash('#k=abc_DEF-123')).toBe('abc_DEF-123');
    expect(keyFromHash('#x=1&k=abc')).toBe('abc');
    expect(keyFromHash('')).toBeNull();
    expect(keyFromHash('#k=')).toBeNull();
  });
});

describe('S0 Setup (doc 05 §5, doc 03 §4.9)', () => {
  it('stores the key, removes the fragment and says the tablet is registered', async () => {
    const check = vi.fn(() => Promise.resolve());
    openSetup('/setup#k=kunci-baru', check);
    expect(screen.getByText('Memeriksa tablet…')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Tablet terdaftar' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Pasang aplikasi ini dari menu Chrome (Install app), lalu buka dari layar utama.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lanjut' })).toBeInTheDocument();
    expect(await repo.getDeviceKey(db)).toBe('kunci-baru');
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/setup');
    expect(check).toHaveBeenCalled();
  });

  it('replaces an earlier key', async () => {
    await repo.saveDeviceKey(db, 'kunci-lama');
    openSetup('/setup#k=kunci-baru', () => Promise.resolve());
    await screen.findByRole('heading', { name: 'Tablet terdaftar' });
    expect(await repo.getDeviceKey(db)).toBe('kunci-baru');
  });

  it('says a refused key is invalid, with no button', async () => {
    openSetup('/setup#k=salah', () =>
      Promise.reject(new ApiError(401, 'DEVICE_KEY_INVALID', 'Tablet belum terdaftar.')),
    );
    expect(
      await screen.findByText('Kunci tablet tidak valid. Minta tautan setup yang baru dari admin.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(window.location.hash).toBe('');
  });

  it('offers Coba lagi without a connection, and a retry succeeds', async () => {
    let online = false;
    openSetup('/setup#k=kunci', () =>
      online ? Promise.resolve() : Promise.reject(new OfflineError()),
    );
    expect(
      await screen.findByText('Tidak bisa terhubung ke server. Periksa Wi-Fi, lalu coba lagi.'),
    ).toBeInTheDocument();
    online = true;
    fireEvent.click(screen.getByRole('button', { name: 'Coba lagi' }));
    expect(await screen.findByRole('heading', { name: 'Tablet terdaftar' })).toBeInTheDocument();
  });

  it('checks a stored key when opened without one', async () => {
    await repo.saveDeviceKey(db, 'kunci-lama');
    const check = vi.fn(() => Promise.resolve());
    openSetup('/setup', check);
    expect(await screen.findByRole('heading', { name: 'Tablet terdaftar' })).toBeInTheDocument();
  });

  it('says the tablet is not registered without a key in the link or stored', async () => {
    const check = vi.fn(() => Promise.resolve());
    openSetup('/setup', check);
    expect(
      await screen.findByText('Tablet ini belum terdaftar. Buka tautan setup dari admin.'),
    ).toBeInTheDocument();
    expect(check).not.toHaveBeenCalled();
  });
});
