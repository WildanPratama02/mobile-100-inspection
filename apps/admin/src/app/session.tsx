/**
 * The admin session (doc 04 §2, doc 05 §20.2): `GET /admin/me` at start; a `401 ADMIN_AUTH_REQUIRED` on any request,
 * or the end of the 8-hour cookie, returns to the login screen with a notice. No "remember me".
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, onAuthRequired } from '../api/client';
import * as api from '../api/endpoints';
import type { AdminMe } from '../api/types';
import { asApiError } from '../common/useResource';

/** The session cookie's lifetime (doc 04 §2). */
export const SESSION_MS = 8 * 60 * 60 * 1000;

export type SessionState =
  | { status: 'checking' }
  | { status: 'unavailable'; error: ApiError }
  | { status: 'signed-out'; expired: boolean }
  | { status: 'signed-in'; me: AdminMe };

interface SessionApi {
  state: SessionState;
  /** Logs in; rejects with the API's problem. */
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  retry: () => void;
}

const SessionContext = createContext<SessionApi | null>(null);

export const SESSION_ENDED_TEXT = 'Sesi berakhir. Silakan masuk lagi.';

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'checking' });

  const check = useCallback(() => {
    api.me().then(
      (me) => setState({ status: 'signed-in', me }),
      (error: unknown) => {
        const problem = asApiError(error);
        setState(
          problem.status === 401
            ? { status: 'signed-out', expired: false }
            : { status: 'unavailable', error: problem },
        );
      },
    );
  }, []);

  useEffect(check, [check]);

  useEffect(
    () =>
      onAuthRequired(() =>
        setState((s) => (s.status === 'signed-in' ? { status: 'signed-out', expired: true } : s)),
      ),
    [],
  );

  // The cookie lasts 8 hours from login; end the screen with it rather than at the next request.
  const loginAt = state.status === 'signed-in' ? state.me.lastLoginAt : undefined;
  useEffect(() => {
    if (!loginAt) return;
    const left = Date.parse(loginAt) + SESSION_MS - Date.now();
    if (Number.isNaN(left)) return;
    const timer = window.setTimeout(
      () => setState({ status: 'signed-out', expired: true }),
      Math.max(0, Math.min(left, 2 ** 31 - 1)),
    );
    return () => window.clearTimeout(timer);
  }, [loginAt]);

  const signIn = useCallback(async (username: string, password: string) => {
    await api.login(username, password);
    const me = await api.me();
    setState({ status: 'signed-in', me });
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // The cookie may already be gone; the login screen is the right place either way.
    }
    setState({ status: 'signed-out', expired: false });
  }, []);

  const retry = useCallback(() => {
    setState({ status: 'checking' });
    check();
  }, [check]);

  const value = useMemo(() => ({ state, signIn, signOut, retry }), [state, signIn, signOut, retry]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSession(): SessionApi {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionProvider');
  return session;
}
