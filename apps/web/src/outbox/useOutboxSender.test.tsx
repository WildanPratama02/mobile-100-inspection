import { act, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../app/toast';
import { createDb, type Auth, type M100Db, type OutboxRow } from '../db/schema';
import { AppStoreContext, createAppStore, type AppStore } from '../state/store';
import type { OutboxSender } from './sender';
import { OUTBOX_TIMER_MS, useFailedOutboxToast, useOutboxSenderLoop } from './useOutboxSender';

const AUTH: Auth = {
  username: 'DEWI CONTOH',
  level: 'PSI lv.2',
  factory: 'F 3',
  cell: 'F3-10',
  token: null,
  tokenExpiresAt: null,
};

const row = (uuid: string, state: OutboxRow['state']): OutboxRow => ({
  submissionUuid: uuid,
  po: '0903359388',
  sealedAt: '2026-10-16T07:32:05.000Z',
  payloadJson: '{}',
  payloadSha256: 'x',
  authorUsername: AUTH.username,
  authorToken: null,
  authorTokenExpiresAt: null,
  state,
  attempts: 0,
  nextAttemptAt: '2026-10-16T07:32:05.000Z',
  lastAttemptAt: null,
  problem: null,
  problemErrors: [],
  displayNo: null,
  sentAt: null,
});

function fakeSender() {
  return {
    run: vi.fn(() => Promise.resolve()),
    start: vi.fn(() => Promise.resolve()),
    send: vi.fn(() => Promise.resolve(undefined)),
  } satisfies OutboxSender;
}

describe('useOutboxSenderLoop (doc 03 §4.6)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts once, forces on online, runs on focus, on becoming visible and every 30 s', () => {
    const sender = fakeSender();
    const { unmount } = renderHook(() => useOutboxSenderLoop(sender, true));
    expect(sender.start).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('online'));
    expect(sender.run).toHaveBeenLastCalledWith({ force: true });
    window.dispatchEvent(new Event('focus'));
    expect(sender.run).toHaveBeenLastCalledWith();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sender.run).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(OUTBOX_TIMER_MS);
    expect(sender.run).toHaveBeenCalledTimes(4);

    unmount();
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(OUTBOX_TIMER_MS);
    expect(sender.run).toHaveBeenCalledTimes(4);
  });

  it('does nothing while disabled (no device key, setup page)', () => {
    const sender = fakeSender();
    renderHook(() => useOutboxSenderLoop(sender, false));
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(OUTBOX_TIMER_MS);
    expect(sender.start).not.toHaveBeenCalled();
    expect(sender.run).not.toHaveBeenCalled();
  });
});

describe('useFailedOutboxToast (doc 05 §13.3, AC-11.4)', () => {
  let db: M100Db;
  let store: AppStore;

  beforeEach(async () => {
    db = createDb(`toast-${crypto.randomUUID()}`);
    store = createAppStore(db);
    await store.getState().hydrate();
    await store.getState().login(AUTH);
  });

  afterEach(async () => {
    await db.delete();
  });

  function Watcher() {
    useFailedOutboxToast();
    return null;
  }

  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppStoreContext.Provider value={store}>
      <ToastProvider>{children}</ToastProvider>
    </AppStoreContext.Provider>
  );

  it('announces an item of the PSI that turns Gagal, once, and not one that was Gagal already', () => {
    act(() => store.setState({ outbox: [row('a', 'waiting'), row('b', 'failed')] }));
    render(<Watcher />, { wrapper });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    act(() => store.setState({ outbox: [row('a', 'sending'), row('b', 'failed')] }));
    expect(screen.queryByText(/gagal/)).not.toBeInTheDocument();
    act(() => store.setState({ outbox: [row('a', 'failed'), row('b', 'failed')] }));
    expect(
      screen.getByText('Pengiriman PO 0903359388 gagal. Lihat Pengaturan.'),
    ).toBeInTheDocument();
  });

  it('does not announce the Gagal items of a PSI who just logged in', () => {
    render(<Watcher />, { wrapper });
    act(() =>
      store.setState({
        auth: { ...AUTH, username: 'ANDI CONTOH' },
        outbox: [{ ...row('c', 'failed'), authorUsername: 'ANDI CONTOH' }],
      }),
    );
    expect(screen.queryByText(/gagal/)).not.toBeInTheDocument();
  });
});
