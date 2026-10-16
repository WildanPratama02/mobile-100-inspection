import type { ReactNode } from 'react';
import { cx } from './cx';

export interface NoticeProps {
  tone?: 'warning' | 'danger';
  title?: string;
  children?: ReactNode;
  className?: string;
}

export function Notice({ tone, title, children, className }: NoticeProps) {
  return (
    <div
      className={cx('m100-notice', tone && `m100-notice--${tone}`, className)}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      {title ? <b>{title} </b> : null}
      {children}
    </div>
  );
}
