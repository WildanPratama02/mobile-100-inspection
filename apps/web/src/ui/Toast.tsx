import type { ReactNode } from 'react';
import { cx } from './cx';

export interface ToastProps {
  tone?: 'neutral' | 'error';
  floating?: boolean;
  children?: ReactNode;
  className?: string;
}

export function Toast({ tone, floating, children, className }: ToastProps) {
  return (
    <div
      className={cx(
        'm100-toast',
        tone === 'error' && 'm100-toast--error',
        floating && 'm100-toast--floating',
        className,
      )}
      role="status"
    >
      {children}
    </div>
  );
}
