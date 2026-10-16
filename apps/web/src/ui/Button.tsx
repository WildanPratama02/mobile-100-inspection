import type { ButtonHTMLAttributes } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  block?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  block,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        'm100-btn',
        `m100-btn--${variant}`,
        `m100-btn--${size}`,
        block && 'm100-btn--block',
        className,
      )}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}
