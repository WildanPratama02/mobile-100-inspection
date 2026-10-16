import type { ReactNode } from 'react';
import { cx } from './cx';

export interface PaneProps {
  children?: ReactNode;
  /** Names the region for screen readers. */
  label?: string;
  className?: string;
}

export function Pane({ children, label, className }: PaneProps) {
  return (
    <section className={cx('m100-pane', className)} aria-label={label}>
      {children}
    </section>
  );
}
