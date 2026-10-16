import type { CSSProperties } from 'react';
import { CountBadge } from './CountBadge';
import { cx } from './cx';

export interface AreaPillProps {
  style?: CSSProperties;
  label?: string;
  lines?: string[];
  selected?: boolean;
  count?: number;
  /** General is not a place on the shoe: dashed border, no leader line. */
  general?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}

export function AreaPill({
  style,
  label,
  lines,
  selected,
  count,
  general,
  disabled,
  onClick,
  className,
}: AreaPillProps) {
  const text = lines ?? (label != null ? [label] : []);
  return (
    <button
      type="button"
      style={style}
      className={cx(
        'm100-pill',
        text.length > 1 && 'm100-pill--two',
        general && 'm100-pill--general',
        className,
      )}
      aria-pressed={!!selected}
      disabled={disabled}
      onClick={onClick}
      aria-label={text.join(' ')}
    >
      {text.map((line, i) => (
        <span key={i}>{line}</span>
      ))}
      <CountBadge value={count} />
    </button>
  );
}
