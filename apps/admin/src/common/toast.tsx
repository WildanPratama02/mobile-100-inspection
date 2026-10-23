import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Toast } from '@m100/ui';

type Show = (text: string, tone?: 'neutral' | 'error') => void;

const ToastContext = createContext<Show>(() => undefined);

const VISIBLE_MS = 5000;

/** One floating `Toast` at a time ("saved" state, doc 05 §20.8). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; tone: 'neutral' | 'error'; n: number } | null>(
    null,
  );
  const show = useCallback<Show>((text, tone = 'neutral') => {
    setToast((t) => ({ text, tone, n: (t?.n ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast ? (
        <Toast key={toast.n} tone={toast.tone} floating>
          {toast.text}
        </Toast>
      ) : null}
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): Show {
  return useContext(ToastContext);
}

/** The saved text of the master-data screens (doc 05 §20.4, AC-14.1). */
export const SAVED_MASTER = 'Disimpan. Tablet menerima perubahan dalam 30 menit.';
