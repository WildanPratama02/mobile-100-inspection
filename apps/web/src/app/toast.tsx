import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Toast } from '../ui';
import { TOAST_MS, ToastContext, type ShowToast, type ToastTone } from './toastContext';

interface Current {
  id: number;
  text: string;
  tone: ToastTone;
}

/** One floating toast at a time; a new one replaces the old (doc 05 G4). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Current | null>(null);

  const show = useCallback<ShowToast>((text, tone = 'neutral') => {
    setCurrent((previous) => ({ id: (previous?.id ?? 0) + 1, text, tone }));
  }, []);

  useEffect(() => {
    if (!current) return;
    const timer = window.setTimeout(() => setCurrent(null), TOAST_MS[current.tone]);
    return () => window.clearTimeout(timer);
  }, [current]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {current ? (
        <Toast key={current.id} floating tone={current.tone}>
          {current.text}
        </Toast>
      ) : null}
    </ToastContext.Provider>
  );
}
