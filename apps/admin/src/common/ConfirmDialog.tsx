import type { ReactNode } from 'react';
import { Button, Dialog } from '@m100/ui';
import type { ApiError } from '../api/client';
import { Overlay } from './Overlay';
import { ProblemNotice } from './StateView';

export interface ConfirmDialogProps {
  title: string;
  /** Names the target (doc 05 §20.1: impactful actions go through a Dialog that names it). */
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: ApiError | null;
  /** Shown instead of the API `detail` for some codes. */
  errorText?: (error: ApiError) => string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  busy,
  error,
  errorText,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancel = () => {
    if (!busy) onCancel();
  };
  return (
    <Overlay onDismiss={cancel}>
      <Dialog title={title} onClose={cancel} role="alertdialog">
        <div className="adm-confirm">
          <div>{children}</div>
          {error ? <ProblemNotice error={error} text={errorText?.(error)} /> : null}
          <div className="adm-actions">
            <Button onClick={cancel} disabled={busy} data-autofocus>
              BATAL
            </Button>
            <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
              {busy ? 'Memproses…' : confirmLabel}
            </Button>
          </div>
        </div>
      </Dialog>
    </Overlay>
  );
}
