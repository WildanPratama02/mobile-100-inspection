import { useState } from 'react';
import { Button, Pane } from '@m100/ui';
import type { ApiError } from '../api/client';
import * as api from '../api/endpoints';
import type { AdminPsiUser, PsiLevel } from '../api/types';
import { DataTable, type Column } from '../common/DataTable';
import { CheckField, SelectInput, TextField } from '../common/fields';
import { FormDialog } from '../common/FormDialog';
import { Empty, LoadError, Loading } from '../common/StateView';
import { SAVED_MASTER, useToast } from '../common/toast';
import { asApiError, useResource } from '../common/useResource';

export const DUPLICATE_USER_TEXT = 'Nama dan level ini sudah ada.';
const LEVELS: PsiLevel[] = ['PSI lv.1', 'PSI lv.2'];

/** A2 — PSI users: Nama, Level, Aktif, search; add and edit, no delete (doc 05 §20.4). */
export function PsiUsers() {
  const users = useResource(api.listPsiUsers, 'psi-users');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<AdminPsiUser | 'new' | null>(null);

  const q = search.trim().toLowerCase();
  const rows = (users.data ?? []).filter((u) => !q || u.username.toLowerCase().includes(q));

  const columns: Column<AdminPsiUser>[] = [
    { key: 'name', header: 'Nama', cell: (u) => u.username },
    { key: 'level', header: 'Level', cell: (u) => u.level },
    { key: 'active', header: 'Aktif', cell: (u) => (u.active ? 'Ya' : 'Tidak') },
    {
      key: 'edit',
      header: '',
      cell: (u) => (
        <Button
          size="sm"
          onClick={() => setEditing(u)}
          aria-label={`Ubah ${u.username} ${u.level}`}
        >
          UBAH
        </Button>
      ),
    },
  ];

  return (
    <Pane label="User PSI">
      <div className="adm-toolbar">
        <h1 className="adm-title">User PSI</h1>
        <div className="adm-toolbar__end">
          <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing('new')}>
            TAMBAH
          </Button>
        </div>
      </div>
      <TextField
        label="Cari nama"
        type="search"
        value={search}
        onChange={setSearch}
        autoComplete="off"
      />
      {users.state === 'loading' ? <Loading /> : null}
      {users.state === 'error' ? <LoadError error={users.error} onRetry={users.reload} /> : null}
      {users.state === 'ok' && rows.length === 0 ? (
        <Empty
          action={
            <Button size="sm" onClick={() => setEditing('new')}>
              TAMBAH
            </Button>
          }
        >
          {q ? 'Tidak ada user PSI dengan nama ini.' : 'Belum ada user PSI.'}
        </Empty>
      ) : null}
      {users.state === 'ok' && rows.length > 0 ? (
        <DataTable
          label="Daftar user PSI"
          columns={columns}
          rows={rows}
          rowKey={(u) => u.id}
          muted={(u) => !u.active}
        />
      ) : null}
      {editing ? (
        <PsiUserDialog
          user={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            users.reload();
          }}
        />
      ) : null}
    </Pane>
  );
}

function PsiUserDialog({
  user,
  onClose,
  onSaved,
}: {
  user: AdminPsiUser | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [username, setUsername] = useState(user?.username ?? '');
  const [level, setLevel] = useState<PsiLevel>(user?.level ?? 'PSI lv.1');
  const [active, setActive] = useState(user?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const name = username.trim();
  const changes = user
    ? {
        ...(name !== user.username ? { username: name } : {}),
        ...(level !== user.level ? { level } : {}),
        ...(active !== user.active ? { active } : {}),
      }
    : null;
  const dirty = user ? Object.keys(changes ?? {}).length > 0 : name !== '';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (user) await api.updatePsiUser(user.id, changes ?? {});
      else await api.createPsiUser({ username: name, level });
      toast(SAVED_MASTER);
      onSaved();
    } catch (e) {
      setError(asApiError(e));
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title={user ? `Ubah user PSI: ${user.username}` : 'Tambah user PSI'}
      dirty={dirty}
      busy={busy}
      error={error}
      errorText={(e) => (e.code === 'CONFLICT' ? DUPLICATE_USER_TEXT : undefined)}
      submitDisabled={!name || (user !== null && !dirty)}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <TextField
        label="Nama"
        value={username}
        onChange={setUsername}
        maxLength={100}
        autoComplete="off"
        hint="Persis seperti tampil di tablet."
      />
      <SelectInput
        label="Level"
        value={level}
        onChange={(v) => setLevel(v as PsiLevel)}
        options={LEVELS.map((l) => ({ value: l, label: l }))}
      />
      {user ? <CheckField label="Aktif" checked={active} onChange={setActive} /> : null}
    </FormDialog>
  );
}
