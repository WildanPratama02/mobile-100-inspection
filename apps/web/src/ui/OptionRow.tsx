import { Chip, type Classification } from './Chip';
import { cx } from './cx';
import { Icon } from './Icon';

export interface OptionRowProps {
  kind?: 'nav' | 'defect';
  title: string;
  sub?: string;
  count?: number;
  classification?: Classification;
  qty?: number;
  flash?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}

export function OptionRow({
  kind = 'nav',
  title,
  sub,
  count,
  classification,
  qty,
  flash,
  disabled,
  onClick,
  className,
}: OptionRowProps) {
  return (
    <button
      type="button"
      className={cx('m100-row', `m100-row--${kind}`, flash && 'm100-flash', className)}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="m100-row__t">
        {title}
        {sub ? <small>{sub}</small> : null}
      </span>
      {kind === 'defect' && classification ? <Chip tone={classification} /> : null}
      {qty ? <span className="m100-row__q">{qty}</span> : null}
      {kind === 'nav' && count != null ? <span className="m100-row__n">{count}</span> : null}
      {kind === 'nav' ? <Icon name="chevron-right" /> : null}
    </button>
  );
}
