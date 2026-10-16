import { CountBadge } from './CountBadge';
import { cx } from './cx';

export interface POListItemProps {
  po: string;
  sub?: string;
  count?: number;
  live?: string;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
}

export function POListItem({
  po,
  sub,
  count,
  live,
  selected,
  onClick,
  className,
}: POListItemProps) {
  return (
    <button
      type="button"
      className={cx('m100-po', className)}
      aria-current={!!selected}
      onClick={onClick}
    >
      {po}
      {sub ? <small>{sub}</small> : null}
      {live ? <em>{live}</em> : null}
      <CountBadge value={count} label={count ? `${count} defect` : undefined} />
    </button>
  );
}
