/** Plain HTML form fields styled with the tokens (doc 05 §20: no new design-system component in release 1). */
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

interface FieldFrame {
  label: string;
  hint?: ReactNode;
  /** A field-level problem, shown under the field. */
  problem?: string;
}

export interface TextFieldProps
  extends FieldFrame, Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: string;
  onChange: (value: string) => void;
}

export function TextField({ label, hint, problem, value, onChange, ...rest }: TextFieldProps) {
  const id = useId();
  return (
    <div className="adm-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="adm-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem || hint ? `${id}-note` : undefined}
        {...rest}
      />
      {problem || hint ? (
        <span id={`${id}-note`} className={problem ? 'adm-field__problem' : 'adm-field__hint'}>
          {problem ?? hint}
        </span>
      ) : null}
    </div>
  );
}

export interface SelectInputProps
  extends FieldFrame, Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  /** A first option for "no choice", e.g. "Semua". */
  emptyLabel?: string;
}

export function SelectInput({
  label,
  hint,
  problem,
  value,
  onChange,
  options,
  emptyLabel,
  ...rest
}: SelectInputProps) {
  const id = useId();
  return (
    <div className="adm-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="adm-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={problem ? true : undefined}
        {...rest}
      >
        {emptyLabel !== undefined ? <option value="">{emptyLabel}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {problem || hint ? (
        <span className={problem ? 'adm-field__problem' : 'adm-field__hint'}>
          {problem ?? hint}
        </span>
      ) : null}
    </div>
  );
}

export interface CheckFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

/** A checkbox whose whole label is the tap target (≥ 44 px). */
export function CheckField({ label, checked, onChange, disabled }: CheckFieldProps) {
  return (
    <label className="adm-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
