import { useState, type FormEvent } from 'react';
import { Button, Notice, Pane } from '@m100/ui';
import type { ApiError } from '../api/client';
import { SESSION_ENDED_TEXT, useSession } from '../app/session';
import logoUrl from '../assets/parkland.png';
import { TextField } from '../common/fields';
import { asApiError } from '../common/useResource';

/** The login texts of doc 05 §20.2. */
export const LOGIN_FAILED_TEXT = 'Username atau password salah.';
export const LOCKED_TEXT = 'Akun dikunci 10 menit karena terlalu banyak percobaan.';

// eslint-disable-next-line react-refresh/only-export-components
export function loginErrorText(error: ApiError): string {
  if (error.code === 'ADMIN_LOGIN_FAILED') return LOGIN_FAILED_TEXT;
  if (error.code === 'ADMIN_LOCKED') return LOCKED_TEXT;
  if (error.code === 'VALIDATION_FAILED') return 'Isi username dan password.';
  return error.detail;
}

/** A0 — username, password, MASUK. No "remember me" (doc 05 §20.2). */
export function Login({ expired }: { expired: boolean }) {
  const { signIn } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), password);
    } catch (e) {
      setError(asApiError(e));
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <div className="adm-center">
      <Pane label="Login admin" className="adm-login">
        <img src={logoUrl} alt="PT Parkland World Indonesia" className="adm-logo adm-logo--login" />
        <h1 className="adm-title">M100 Admin</h1>
        {expired && !error ? <Notice tone="warning">{SESSION_ENDED_TEXT}</Notice> : null}
        <form className="adm-form" onSubmit={(e) => void submit(e)} noValidate>
          <TextField
            label="Username"
            value={username}
            onChange={setUsername}
            autoComplete="username"
            autoFocus
            required
          />
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            required
          />
          {error ? <Notice tone="danger">{loginErrorText(error)}</Notice> : null}
          <Button type="submit" variant="primary" block disabled={busy}>
            {busy ? 'Memproses…' : 'MASUK'}
          </Button>
        </form>
      </Pane>
    </div>
  );
}
