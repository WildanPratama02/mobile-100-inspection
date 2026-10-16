import { formatCount } from '@m100/shared';
import { cx } from './cx';
import { Icon } from './Icon';

export interface NumberPadProps {
  label?: string;
  /** Digit string without separators. */
  value: string;
  max?: number;
  unit?: string;
  placeholder?: string;
  hint?: string;
  onChange?: (digits: string) => void;
  className?: string;
}

const MAX_DIGITS = 9;
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** In-app digit pad (ADR-013): the tablet keyboard never opens. */
export function NumberPad({
  label,
  value,
  max,
  unit,
  placeholder,
  hint,
  onChange,
  className,
}: NumberPadProps) {
  const digits = value ?? '';
  const n = digits === '' ? 0 : parseInt(digits, 10);
  const over = max != null && n > max ? max : null;
  const zero = digits !== '' && n < 1;
  const bad = over != null || zero;
  const message =
    over != null
      ? `Maksimum ${formatCount(over)} pasang`
      : zero
        ? 'Minimal 1 pasang'
        : (hint ?? '');

  const press = (d: string) => {
    if (!onChange) return;
    const next = (digits === '0' ? '' : digits) + d;
    if (next.length > MAX_DIGITS) return;
    onChange(next);
  };

  return (
    <div className={cx('m100-pad', className)} role="group" aria-label={label ?? 'Input angka'}>
      {label ? <span className="m100-pad__label">{label}</span> : null}
      <output className={cx('m100-pad__out', bad && 'm100-pad__out--bad')} aria-live="polite">
        {digits === '' ? <span className="m100-ph">{placeholder ?? '0'}</span> : formatCount(n)}
        {unit ? <small>{unit}</small> : null}
      </output>
      <div className={cx('m100-pad__msg', bad && 'm100-pad__msg--bad')}>{message}</div>
      <div className="m100-pad__keys">
        {KEYS.map((k) => (
          <button key={k} type="button" className="m100-pad__k" onClick={() => press(k)}>
            {k}
          </button>
        ))}
        <button
          type="button"
          className="m100-pad__k m100-pad__k--fn"
          onClick={() => onChange?.('')}
        >
          HAPUS
        </button>
        <button type="button" className="m100-pad__k" onClick={() => press('0')}>
          0
        </button>
        <button
          type="button"
          className="m100-pad__k m100-pad__k--fn"
          aria-label="Hapus satu angka"
          onClick={() => onChange?.(digits.slice(0, -1))}
        >
          <Icon name="back" />
        </button>
      </div>
    </div>
  );
}
