import { createContext, useContext, useEffect, useRef } from 'react';
import { useToast } from '../app/toastContext';
import type { OutboxState } from '../db/schema';
import { useAppStore } from '../state/store';
import type { CorrectionChecker } from './corrections';
import type { OutboxSender } from './sender';

/** How often the sender looks for items whose wait is over while the app is open (doc 03 §4.6). */
export const OUTBOX_TIMER_MS = 30_000;

/** The app's sender, given by `App`; `null` in screen tests that render without one. */
export const OutboxSenderContext = createContext<OutboxSender | null>(null);

export function useOutboxSender(): OutboxSender | null {
  return useContext(OutboxSenderContext);
}

/** How often the correction check runs while the app is open (AC-17.6: within 30 minutes). */
export const CORRECTION_CHECK_MS = 30 * 60 * 1000;

/** The app's correction check (ADR-023); `null` in screen tests without one. */
export const CorrectionCheckerContext = createContext<CorrectionChecker | null>(null);

export function useCorrectionChecker(): CorrectionChecker | null {
  return useContext(CorrectionCheckerContext);
}

/**
 * Runs the correction check (doc 03 §4.11): after the sender's start, when the connection comes back (after that
 * pass), and every 30 minutes. Pengaturan runs it too when it opens.
 */
export function useCorrectionCheckLoop(
  checker: CorrectionChecker | null,
  sender: OutboxSender | null,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!checker || !enabled) return;
    const check = () => void checker.check();
    const afterSend = () => void (sender?.run() ?? Promise.resolve()).finally(check);
    afterSend();
    const timer = window.setInterval(check, CORRECTION_CHECK_MS);
    window.addEventListener('online', afterSend);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', afterSend);
    };
  }, [checker, sender, enabled]);
}

/**
 * Runs the sender while the app is open (doc 03 §4.6): at start (items left Mengirim are resent, every Menunggu
 * item is tried at once), when the connection comes back (also at once), when the app regains focus and every 30 s
 * (both after each item's wait). KIRIM runs it too (`HomeScreen`). It runs whoever is logged in, also on the login
 * screen, so a logged-out author's submissions still go (doc 05 §14).
 */
export function useOutboxSenderLoop(sender: OutboxSender | null, enabled: boolean): void {
  useEffect(() => {
    if (!sender || !enabled) return;
    const fail = (error: unknown) => console.error(error);
    const run = () => void sender.run().catch(fail);
    const onOnline = () => void sender.run({ force: true }).catch(fail);
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    sender.start().catch(fail);
    const timer = window.setInterval(run, OUTBOX_TIMER_MS);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', run);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sender, enabled]);
}

/**
 * "Pengiriman PO {no} gagal. Lihat Pengaturan." whenever one of the logged-in PSI's items turns Gagal, after KIRIM
 * or in the background (doc 05 §13.3, AC-11.4: a refusal is never silent). Items already Gagal at login are not
 * announced again; they show in the gear menu.
 */
export function useFailedOutboxToast(): void {
  const toast = useToast();
  const username = useAppStore((s) => s.auth?.username ?? null);
  const outbox = useAppStore((s) => s.outbox);
  const seen = useRef<{ username: string | null; states: Map<string, OutboxState> } | null>(null);

  useEffect(() => {
    const states = new Map(outbox.map((o) => [o.submissionUuid, o.state]));
    const before = seen.current;
    seen.current = { username, states };
    if (before?.username !== username) return;
    for (const item of outbox) {
      const previous = before.states.get(item.submissionUuid);
      if (item.state === 'failed' && previous !== undefined && previous !== 'failed') {
        toast(`Pengiriman PO ${item.po} gagal. Lihat Pengaturan.`, 'error');
      }
    }
  }, [outbox, username, toast]);
}
