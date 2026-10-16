import { NO_VALUE } from '@m100/shared';
import { cx } from './cx';

export interface StatRowProps {
  label: string;
  /** Already formatted in id-ID style; `null` shows "—". */
  value?: string | number | null;
  unit?: string;
  tone?: 'bad' | 'good';
  className?: string;
}

export function StatRow({ label, value, unit, tone, className }: StatRowProps) {
  const empty = value == null;
  return (
    <div className={cx('m100-stat', tone && `m100-stat--${tone}`, className)}>
      <span>{label}</span>
      <b>
        {empty ? NO_VALUE : value}
        {unit && !empty ? <small>{unit}</small> : null}
      </b>
    </div>
  );
}
