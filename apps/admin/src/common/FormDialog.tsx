import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, Dialog } from '@m100/ui';
import type { ApiError } from '../api/client';
import { Overlay } from './Overlay';
import { ProblemNotice } from './StateView';
import { useUnsavedGuard } from './unsaved';

export interface FormDialogProps {
  title: string;
  /** True once a field differs from what was loaded: closing or leaving then asks first (doc 05 §20.8). */
  dirty: boolean;
  busy?: boolean;
  error?: ApiError | null;
  /** Shown instead of the API `detail` for some codes (e.g. 409 "Nama dan level ini sudah ada."). */
  errorText?: (error: ApiError) => string | undefined;
  submitLabel?: string;
  submitDisabled?: boolean;
  wide?: boolean;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}

export const UNSAVED_TEXT = 'Perubahan belum disimpan. Tutup tanpa menyimpan?';

/** An add or edit form in a `Dialog`, with SIMPAN / BATAL and the unsaved-changes question. */
export function FormDialog({
  title,
  dirty,
  busy,
  error,
  errorText,
  submitLabel = 'SIMPAN',
  submitDisabled,
  wide,
  onSubmit,
  onClose,
  children,
}: FormDialogProps) {
  // The action to run if the admin leaves without saving; set while the question is shown.
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const ask = (proceed: () => void) => setLeave(() => proceed);
  useUnsavedGuard(dirty && !busy, ask);

  const close = () => {
    if (busy) return;
    if (dirty) ask(onClose);
    else onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && !submitDisabled) onSubmit();
  };

  return (
    <Overlay onDismiss={leave ? () => setLeave(null) : close}>
      <Dialog title={title} onClose={leave ? () => setLeave(null) : close} wide={wide}>
        {leave ? (
          <div className="adm-confirm" role="alert">
            <p>{UNSAVED_TEXT}</p>
            <div className="adm-actions">
              <Button onClick={() => setLeave(null)} data-autofocus>
                KEMBALI
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const proceed = leave;
                  setLeave(null);
                  proceed();
                }}
              >
                TUTUP TANPA MENYIMPAN
              </Button>
            </div>
          </div>
        ) : (
          <form className="adm-form" onSubmit={submit} noValidate>
            {children}
            {error ? <ProblemNotice error={error} text={errorText?.(error)} /> : null}
            <div className="adm-actions">
              <Button onClick={close} disabled={busy}>
                BATAL
              </Button>
              <Button type="submit" variant="primary" disabled={busy || submitDisabled}>
                {busy ? 'Menyimpan…' : submitLabel}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </Overlay>
  );
}
