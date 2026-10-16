import type { ButtonHTMLAttributes } from 'react';
import { cx } from './cx';

export interface CommandButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  mode: 'rework' | 'bgrade' | 'nodefect' | 'end';
  state?: 'idle' | 'active' | 'disabled';
}

const LABEL: Record<CommandButtonProps['mode'], string> = {
  rework: 'REWORK',
  bgrade: 'B-GRADE',
  nodefect: 'NO DEFECT',
  end: 'END INSPECTION',
};

export function CommandButton({
  mode,
  state = 'idle',
  className,
  children,
  disabled,
  ...rest
}: CommandButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cx('m100-cmd', state === 'active' && 'm100-cmd--active', className)}
      disabled={state === 'disabled' || disabled}
      aria-pressed={mode !== 'end' ? state === 'active' : undefined}
    >
      {children ?? LABEL[mode]}
    </button>
  );
}
