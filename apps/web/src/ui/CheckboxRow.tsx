import type { ButtonHTMLAttributes } from 'react';
import { cx } from './cx';
import { Icon } from './Icon';

export interface CheckboxRowProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange'
> {
  checked: boolean;
  label: string;
  sub?: string;
  onChange?: (checked: boolean) => void;
  className?: string;
}

export function CheckboxRow({
  checked,
  label,
  sub,
  onChange,
  className,
  ...rest
}: CheckboxRowProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      {...rest}
      className={cx('m100-check', checked && 'm100-check--on', className)}
      onClick={() => {
        if (!rest.disabled) onChange?.(!checked);
      }}
    >
      <span className="m100-check__box" aria-hidden="true">
        {checked ? <Icon name="check" /> : null}
      </span>
      <span className="m100-check__text">
        {label}
        {sub ? <small>{sub}</small> : null}
      </span>
    </button>
  );
}
