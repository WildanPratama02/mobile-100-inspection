import { useState } from 'react';
import { Button, Pane } from '@m100/ui';
import type { ApiError } from '../api/client';
import * as api from '../api/endpoints';
import type { AdminAccount } from '../api/types';
import { useSession } from '../app/session';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { DataTable, type Column } from '../common/DataTable';
import { TextField } from '../common/fields';
import { FormDialog } from '../common/FormDialog';
import { Empty, LoadError, Loading } from '../common/StateView';
import { useToast } from '../common/toast';
import { asApiError, useResource } from '../common/useResource';
import { moment } from '../format';
import { MIN_PASSWORD } from './OwnPassword';

type Action =
  | { kind: 'add' }
  | { kind: 'reset'; admin: AdminAccount }
  | { kind: 'active'; admin: AdminAccount }
  | null;

/** The refusals of doc 04 §10 A15, by `errors[].code`. */
const REFUSED: Record<string, string> = {
  SELF: 'Anda tidak bisa menonaktifkan akun sendiri.',
  LAST_ACTIVE_ADMIN: 'Admin aktif terakhir tidak bisa dinonaktifkan.',
};

function refusedText(error: ApiError): string | undefined {
  const code = error.errors.find((e) => e.code in REFUSED)?.code;
  if (code) return REFUSED[code];
  if (error.code === 'CONFLICT') return 'Username ini sudah dipakai.';
  return undefined;
}

/** A6 — admins: add, reset a password, deactivate / reactivate (doc 05 §20.6). */
export function Admins() {
  const { state } = useSession();
  const self = state.status === 'signed-in' ? state.me.username : '';
  const admins = useResource(api.listAdmins, 'admins');
  const [action, setAction] = useState<Action>(null);
  const activeCount = (admins.data ?? []).filter((a) => a.active).length;

  const columns: Column<AdminAccount>[] = [
    {
      key: 'username',
      header: 'Username',
      cell: (a) => (a.username === self ? `${a.username} (Anda)` : a.username),
    },
    { key: 'last', header: 'Login terakhir', cell: (a) => moment(a.lastLoginAt) },
    { key: 'active', header: 'Aktif', cell: (a) => (a.active ? 'Ya' : 'Tidak') },
    {
      key: 'locked',
      header: 'Dikunci sampai',
      cell: (a) =>
        a.lockedUntil && Date.parse(a.lockedUntil) > Date.now() ? moment(a.lockedUntil) : '—',
    },
    {
      key: 'actions',
      header: '',
      cell: (a) => {
        const lastActive = a.active && activeCount <= 1;
        return (
          <div className="adm-actions">
            <Button
              size="sm"
              onClick={() => setAction({ kind: 'reset', admin: a })}
              aria-label={`Reset password ${a.username}`}
            >
              RESET PASSWORD
            </Button>
            <Button
              size="sm"
              variant={a.active ? 'danger' : 'secondary'}
              disabled={a.active && (a.username === self || lastActive)}
              title={
                a.username === self
                  ? REFUSED.SELF
                  : lastActive
                    ? REFUSED.LAST_ACTIVE_ADMIN
                    : undefined
              }
              onClick={() => setAction({ kind: 'active', admin: a })}
              aria-label={`${a.active ? 'Nonaktifkan' : 'Aktifkan'} ${a.username}`}
            >
              {a.active ? 'NONAKTIFKAN' : 'AKTIFKAN'}
            </Button>
          </div>
        );
      },
    },
  ];

  const done = () => {
    setAction(null);
    admins.reload();
  };

  return (
    <Pane label="Admin">
      <div className="adm-toolbar">
        <h1 className="adm-title">Admin</h1>
        <div className="adm-toolbar__end">
          <Button
            variant="primary"
            size="sm"
            icon="plus"
            onClick={() => setAction({ kind: 'add' })}
          >
            TAMBAH
          </Button>
        </div>
      </div>
      {admins.state === 'loading' ? <Loading /> : null}
      {admins.state === 'error' ? <LoadError error={admins.error} onRetry={admins.reload} /> : null}
      {admins.state === 'ok' && admins.data.length === 0 ? <Empty>Belum ada admin.</Empty> : null}
      {admins.state === 'ok' && admins.data.length > 0 ? (
        <DataTable
          label="Daftar admin"
          columns={columns}
          rows={admins.data}
          rowKey={(a) => a.id}
          muted={(a) => !a.active}
        />
      ) : null}
      {action?.kind === 'add' || action?.kind === 'reset' ? (
        <PasswordDialog
          admin={action.kind === 'reset' ? action.admin : null}
          onClose={() => setAction(null)}
          onSaved={done}
        />
      ) : null}
      {action?.kind === 'active' ? (
        <ActiveDialog admin={action.admin} onClose={() => setAction(null)} onSaved={done} />
      ) : null}
    </Pane>
  );
}

/** Add an admin (username + initial password), or reset one's password (also clears a lock). */
function PasswordDialog({
  admin,
  onClose,
  onSaved,
}: {
  admin: AdminAccount | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const name = username.trim();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (admin) await api.resetAdminPassword(admin.id, password);
      else await api.createAdmin(name, password);
      toast(admin ? `Password ${admin.username} direset.` : `Admin ${name} ditambahkan.`);
      onSaved();
    } catch (e) {
      setError(asApiError(e));
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title={admin ? `Reset password: ${admin.username}` : 'Tambah admin'}
      dirty={name !== '' || password !== '' || repeat !== ''}
      busy={busy}
      error={error}
      errorText={refusedText}
      submitDisabled={(!admin && !name) || password.length < MIN_PASSWORD || password !== repeat}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      {admin ? null : (
        <TextField
          label="Username"
          value={username}
          onChange={setUsername}
          maxLength={64}
          autoComplete="off"
        />
      )}
      <TextField
        label={admin ? 'Password baru' : 'Password awal'}
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={setPassword}
        hint={`Minimal ${MIN_PASSWORD} karakter.`}
        problem={
          password && password.length < MIN_PASSWORD
            ? `Minimal ${MIN_PASSWORD} karakter.`
            : undefined
        }
      />
      <TextField
        label="Ulangi password"
        type="password"
        autoComplete="new-password"
        value={repeat}
        onChange={setRepeat}
        problem={repeat && repeat !== password ? 'Password tidak sama.' : undefined}
      />
    </FormDialog>
  );
}

function ActiveDialog({
  admin,
  onClose,
  onSaved,
}: {
  admin: AdminAccount;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const active = !admin.active;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.setAdminActive(admin.id, active);
      toast(active ? `${admin.username} diaktifkan.` : `${admin.username} dinonaktifkan.`);
      onSaved();
    } catch (e) {
      setError(asApiError(e));
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      title={active ? 'Aktifkan admin' : 'Nonaktifkan admin'}
      confirmLabel={active ? 'AKTIFKAN' : 'NONAKTIFKAN'}
      danger={!active}
      busy={busy}
      error={error}
      errorText={refusedText}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    >
      <p>
        {active ? 'Aktifkan' : 'Nonaktifkan'} admin <b>{admin.username}</b>?
        {active ? '' : ' Akun ini tidak bisa login lagi sampai diaktifkan.'}
      </p>
    </ConfirmDialog>
  );
}
