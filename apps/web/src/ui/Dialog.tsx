import type { ReactNode } from 'react';
import { cx } from './cx';
import { Icon } from './Icon';

export interface DialogProps {
  title: string;
  children?: ReactNode;
  /** `false` hides the close button: the dialog must be answered. */
  onClose?: (() => void) | false;
  wide?: boolean;
  role?: 'dialog' | 'alertdialog';
  className?: string;
}

/** The panel only; the consumer centres it over the scrim and closes it on scrim tap and Escape. */
export function Dialog({ title, children, onClose, wide, role, className }: DialogProps) {
  return (
    <div
      className={cx('m100-dialog', wide && 'm100-dialog--wide', className)}
      role={role ?? 'dialog'}
      aria-label={title}
    >
      <div className="m100-dialog__head">
        <h3>{title}</h3>
        {onClose !== false ? (
          <button type="button" className="m100-dialog__x" onClick={onClose} aria-label="Tutup">
            <Icon name="close" />
          </button>
        ) : null}
      </div>
      <div className="m100-dialog__body">{children}</div>
    </div>
  );
}
