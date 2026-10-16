import { cx } from './cx';

export interface CountBadgeProps {
  value?: number | null;
  label?: string;
  className?: string;
}

/** Renders nothing for 0 or an empty value. */
export function CountBadge({ value, label, className }: CountBadgeProps) {
  if (value == null || value === 0) return null;
  return (
    <span className={cx('m100-count', className)} aria-label={label}>
      {String(value)}
    </span>
  );
}
