import { Fragment } from 'react';
import { cx } from './cx';

export interface BreadcrumbProps {
  /** The last item is the current level. */
  items: Array<string | { label: string; onClick?: () => void }>;
  className?: string;
}

export function Breadcrumb({ items, className }: BreadcrumbProps) {
  return (
    <nav className={cx('m100-crumbs', className)} aria-label="Posisi">
      {items.map((item, i) => {
        const last = i === items.length - 1;
        const label = typeof item === 'string' ? item : item.label;
        const onClick = last || typeof item === 'string' ? undefined : item.onClick;
        return (
          <Fragment key={i}>
            {i ? <i aria-hidden="true">›</i> : null}
            <button
              type="button"
              className="m100-crumb"
              aria-current={last ? 'page' : undefined}
              onClick={onClick}
            >
              {label}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}
