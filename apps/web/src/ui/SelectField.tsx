import { cx } from './cx';
import { Icon } from './Icon';

export interface SelectFieldProps {
  label?: string;
  value?: string | null;
  placeholder?: string;
  open?: boolean;
  mono?: boolean;
  disabled?: boolean;
  id?: string;
  onClick?: () => void;
  className?: string;
}

/** A captioned field that opens a picker dialog instead of a keyboard. */
export function SelectField({
  label,
  value,
  placeholder,
  open,
  mono,
  disabled,
  id,
  onClick,
  className,
}: SelectFieldProps) {
  return (
    <div className={cx('m100-field', className)}>
      {label ? <span id={id ? `${id}-label` : undefined}>{label}</span> : null}
      <button
        type="button"
        id={id}
        className="m100-select"
        aria-expanded={!!open}
        aria-haspopup="dialog"
        aria-labelledby={id && label ? `${id}-label ${id}` : undefined}
        onClick={onClick}
        disabled={disabled}
      >
        {value != null && value !== '' ? (
          <span
            className={mono ? 'm100-mono' : undefined}
            style={mono ? { fontFamily: 'var(--font-mono)' } : undefined}
          >
            {value}
          </span>
        ) : (
          <span className="m100-ph">{placeholder ?? 'Pilih'}</span>
        )}
        <Icon name="chevron-down" />
      </button>
    </div>
  );
}
