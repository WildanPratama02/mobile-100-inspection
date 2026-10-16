import type { ReactNode } from 'react';
import { cx } from './cx';

export interface ListProps {
  children?: ReactNode;
  role?: string;
  className?: string;
}

export function List({ children, role, className }: ListProps) {
  return (
    <div className={cx('m100-list', className)} role={role}>
      {children}
    </div>
  );
}
