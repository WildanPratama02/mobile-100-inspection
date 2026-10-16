import { cx } from './cx';

export interface StepperProps {
  label?: string;
  value: number;
  min?: number;
  max?: number;
  format?: (v: number) => string;
  disabled?: boolean;
  onChange?: (v: number) => void;
  className?: string;
}

/** − / value / + for a small whole number; a button at its limit turns grey, it does not hide. */
export function Stepper({
  label,
  value,
  min = 1,
  max = 999,
  format,
  disabled,
  onChange,
  className,
}: StepperProps) {
  return (
    <div className={cx('m100-field', className)}>
      {label ? <span>{label}</span> : null}
      <div className="m100-step" role="group" aria-label={label ?? 'Nilai'}>
        <button
          type="button"
          className="m100-step__b"
          aria-label="Kurangi"
          disabled={disabled || value <= min}
          onClick={() => onChange?.(value - 1)}
        >
          −
        </button>
        <output className="m100-step__v" aria-live="polite">
          {format ? format(value) : String(value)}
        </output>
        <button
          type="button"
          className="m100-step__b"
          aria-label="Tambah"
          disabled={disabled || value >= max}
          onClick={() => onChange?.(value + 1)}
        >
          +
        </button>
      </div>
    </div>
  );
}
