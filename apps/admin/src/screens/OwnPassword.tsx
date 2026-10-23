import { useState } from 'react';
import type { ApiError } from '../api/client';
import * as api from '../api/endpoints';
import { TextField } from '../common/fields';
import { FormDialog } from '../common/FormDialog';
import { useToast } from '../common/toast';
import { asApiError } from '../common/useResource';
import { LOCKED_TEXT } from './Login';

export const MIN_PASSWORD = 10;

/**
 * The signed-in admin's own password (`POST /admin/me/password`; opened from the username in the header, user
 * decision 23 Oct 2026). A wrong current password counts as a failed login and can lock the account.
 */
export function OwnPasswordDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const short = next.length > 0 && next.length < MIN_PASSWORD;
  const mismatch = repeat.length > 0 && repeat !== next;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.changeOwnPassword(current, next);
      toast('Password diganti.');
      onClose();
    } catch (e) {
      setError(asApiError(e));
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title="Ganti password"
      dirty={current !== '' || next !== '' || repeat !== ''}
      busy={busy}
      error={error}
      errorText={(e) => (e.code === 'ADMIN_LOCKED' ? LOCKED_TEXT : undefined)}
      submitDisabled={!current || next.length < MIN_PASSWORD || next !== repeat}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <TextField
        label="Password lama"
        type="password"
        autoComplete="current-password"
        value={current}
        onChange={setCurrent}
      />
      <TextField
        label="Password baru"
        type="password"
        autoComplete="new-password"
        value={next}
        onChange={setNext}
        hint={`Minimal ${MIN_PASSWORD} karakter.`}
        problem={short ? `Minimal ${MIN_PASSWORD} karakter.` : undefined}
      />
      <TextField
        label="Ulangi password baru"
        type="password"
        autoComplete="new-password"
        value={repeat}
        onChange={setRepeat}
        problem={mismatch ? 'Password tidak sama.' : undefined}
      />
    </FormDialog>
  );
}
