import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as repo from '../db/repo';
import { createDb, type Auth, type M100Db, type OutboxRow } from '../db/schema';
import { AppStoreContext, createAppStore, type AppStore } from '../state/store';
import { SettingsDialog } from './SettingsDialog';

const AUTH: Auth = {
  username: 'DEWI CONTOH',
  level: 'PSI lv.2',
  factory: 'F 3',
  cell: 'F3-10',
  token: null,
  tokenExpiresAt: null,
};

const item = (
  submissionUuid: string,
  sealedAt: string,
  overrides: Partial<OutboxRow> = {},
): OutboxRow => ({
  submissionUuid,
  po: '0903359388',
  sealedAt,
  payloadJson: '{}',
  payloadSha256: 'x',
  authorUsername: AUTH.username,
  authorToken: null,
  state: 'waiting',
  attempts: 0,
  nextAttemptAt: sealedAt,
  lastAttemptAt: null,
  problem: null,
  ...overrides,
});

let db: M100Db;
let store: AppStore;

beforeEach(() => {
  db = createDb(`settings-${crypto.randomUUID()}`);
  store = createAppStore(db);
});

afterEach(async () => {
  await db.delete();
});

async function renderMenu(...items: OutboxRow[]) {
  for (const o of items) await repo.putOutboxItem(db, o);
  await store.getState().hydrate();
  await store.getState().login(AUTH);
  render(
    <AppStoreContext.Provider value={store}>
      <SettingsDialog auth={AUTH} onClose={() => undefined} />
    </AppStoreContext.Provider>,
  );
  return within(screen.getByRole('region', { name: 'Pengiriman' }));
}

describe('Pengiriman in the gear menu (AC-11.3, doc 05 §14)', () => {
  it('says so when there is nothing', async () => {
    const outbox = await renderMenu();
    expect(outbox.getByText('Tidak ada pengiriman.')).toBeInTheDocument();
  });

  it('lists the PSI’s submissions newest first with PO, WIB time and status', async () => {
    const outbox = await renderMenu(
      item('u1', '2026-10-16T01:05:00.000Z'),
      item('u2', '2026-10-16T07:32:05.000Z', { po: 'CX-0902368685', state: 'sending' }),
      item('u3', '2026-10-16T03:00:00.000Z', { state: 'sent' }),
    );
    const rows = outbox.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toEqual([
      expect.stringMatching(/CX-0902368685.*14:32.*Mengirim/),
      expect.stringMatching(/0903359388.*10:00.*Terkirim/),
      expect.stringMatching(/0903359388.*08:05.*Menunggu/),
    ]);
    // No last attempt is shown while the sender has recorded none (T3.6).
    expect(outbox.getAllByRole('listitem')[2]?.querySelector('small')).toBeNull();
  });

  it('shows the reason and the admin hint for Gagal (AC-11.4)', async () => {
    const outbox = await renderMenu(
      item('u1', '2026-10-16T01:05:00.000Z', {
        state: 'failed',
        problem: 'PO tidak ditemukan di master PO.',
      }),
    );
    const row = outbox.getByRole('listitem');
    expect(row).toHaveTextContent('Gagal');
    expect(row).toHaveTextContent('PO tidak ditemukan di master PO.');
    expect(row).toHaveTextContent('Hubungi admin dengan nomor PO ini.');
  });

  it('never shows another PSI’s submissions on a shared tablet (U14)', async () => {
    const outbox = await renderMenu(
      item('u1', '2026-10-16T01:05:00.000Z', { authorUsername: 'ANDI CONTOH', po: '0902028839' }),
    );
    expect(outbox.getByText('Tidak ada pengiriman.')).toBeInTheDocument();
    expect(screen.queryByText('0902028839')).not.toBeInTheDocument();
  });
});
