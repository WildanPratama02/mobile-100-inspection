import { createContext, useContext } from 'react';

/** Doc 05 G4: 1.4 s, errors 3.2 s. */
export const TOAST_MS = { neutral: 1400, error: 3200 } as const;

export type ToastTone = keyof typeof TOAST_MS;

export type ShowToast = (text: string, tone?: ToastTone) => void;

export const ToastContext = createContext<ShowToast>(() => undefined);

/** Shows a toast at the top centre (doc 05 G4). Toasts confirm; they never carry a decision. */
export function useToast(): ShowToast {
  return useContext(ToastContext);
}
