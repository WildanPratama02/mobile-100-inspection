import { useEffect, type ReactNode } from 'react';
import './app.css';

export interface OverlayProps {
  /** Scrim tap and Escape call this; leave it out for a dialog that must be answered (doc 05 §2). */
  onDismiss?: () => void;
  children: ReactNode;
}

/** Centres one `Dialog` over the scrim. Dialogs are never stacked: show one Overlay at a time. */
export function Overlay({ onDismiss, children }: OverlayProps) {
  useEffect(() => {
    if (!onDismiss) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div
      className="app-scrim"
      data-testid="scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismiss?.();
      }}
    >
      {children}
    </div>
  );
}
