import { NO_VALUE } from '@m100/shared';
import { cx } from './cx';
import { Icon } from './Icon';

export interface StatRowProps {
  label: string;
  /** Already formatted in id-ID style; `null` shows "—". */
  value?: string | number | null;
  unit?: string;
  tone?: 'bad' | 'good';
  className?: string;
  onClick?: () => void;
}

export function StatRow({ label, value, unit, tone, className, onClick }: StatRowProps) {
  const empty = value == null;
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={cx('m100-stat', tone && `m100-stat--${tone}`, className)}
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-label={onClick ? 'Ubah Qty Inspection' : undefined}
    >
      <span>{label}</span>
      <b>
        {empty ? NO_VALUE : value}
        {unit && !empty ? <small>{unit}</small> : null}
        {onClick ? <Icon name="edit" /> : null}
      </b>
    </Tag>
  );
}
