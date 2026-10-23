import { useEffect, useRef, type ReactNode } from 'react';

export interface OverlayProps {
  /** Escape and a click on the scrim call this; leave it out for a dialog that must be answered. */
  onDismiss?: () => void;
  children: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Centres one `Dialog` over the scrim. Keyboard use (T3b.4): focus moves into the dialog, Tab stays inside it,
 * Escape closes it, and focus returns to what opened it.
 */
export function Overlay({ onDismiss, children }: OverlayProps) {
  const ref = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    // The first field of the dialog body rather than the close button in its head.
    const inBody = FOCUSABLE.split(', ')
      .map((s) => `.m100-dialog__body ${s}`)
      .join(', ');
    const first =
      root?.querySelector<HTMLElement>('[data-autofocus]') ??
      root?.querySelector<HTMLElement>(inBody) ??
      root?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismiss.current) {
        event.preventDefault();
        dismiss.current();
        return;
      }
      if (event.key !== 'Tab' || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const inside = ref.current.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      ref={ref}
      className="adm-scrim"
      data-testid="scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) dismiss.current?.();
      }}
    >
      {children}
    </div>
  );
}
