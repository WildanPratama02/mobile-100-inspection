import { useState } from 'react';
import { Button, Pane } from '@m100/ui';
import type { ApiError } from '../api/client';
import * as api from '../api/endpoints';
import type { AdminCell, AdminFactory } from '../api/types';
import { DataTable, type Column } from '../common/DataTable';
import { CheckField, SelectInput, TextField } from '../common/fields';
import { FormDialog } from '../common/FormDialog';
import { Empty, LoadError, Loading } from '../common/StateView';
import { SAVED_MASTER, useToast } from '../common/toast';
import { asApiError, useResource } from '../common/useResource';

type Editing =
  { kind: 'factory'; row: AdminFactory | null } | { kind: 'cell'; row: AdminCell | null } | null;

/** A3 — two linked tables: factories, and the cells of the chosen factory (doc 05 §20.4). */
export function FactoriesCells() {
  const factories = useResource(api.listFactories, 'factories');
  const [chosenId, setChosenId] = useState<number | null>(null);
  const chosen = factories.data?.find((f) => f.id === chosenId) ?? factories.data?.[0] ?? null;
  const cells = useResource(
    () => (chosen ? api.listCells(chosen.id) : Promise.resolve([])),
    `cells:${chosen?.id ?? ''}`,
  );
  const [editing, setEditing] = useState<Editing>(null);

  const factoryColumns: Column<AdminFactory>[] = [
    {
      key: 'name',
      header: 'Factory',
      cell: (f) => (
        <button
          type="button"
          className="adm-link adm-link--button"
          aria-pressed={f.id === chosen?.id}
          onClick={() => setChosenId(f.id)}
        >
          {f.name}
        </button>
      ),
    },
    { key: 'active', header: 'Aktif', cell: (f) => (f.active ? 'Ya' : 'Tidak') },
    {
      key: 'edit',
      header: '',
      cell: (f) => (
        <Button
          size="sm"
          onClick={() => setEditing({ kind: 'factory', row: f })}
          aria-label={`Ubah ${f.name}`}
        >
          UBAH
        </Button>
      ),
    },
  ];

  const cellColumns: Column<AdminCell>[] = [
    { key: 'code', header: 'Cell', cell: (c) => c.code },
    { key: 'factory', header: 'Factory', cell: (c) => c.factory },
    { key: 'active', header: 'Aktif', cell: (c) => (c.active ? 'Ya' : 'Tidak') },
    {
      key: 'edit',
      header: '',
      cell: (c) => (
        <Button
          size="sm"
          onClick={() => setEditing({ kind: 'cell', row: c })}
          aria-label={`Ubah ${c.code}`}
        >
          UBAH
        </Button>
      ),
    },
  ];

  const saved = () => {
    setEditing(null);
    factories.reload();
    cells.reload();
  };

  return (
    <Pane label="Factory & cell">
      <h1 className="adm-title">Factory &amp; cell</h1>
      <div className="adm-split">
        <section aria-label="Factory">
          <div className="adm-toolbar">
            <h2 className="adm-subtitle">Factory</h2>
            <div className="adm-toolbar__end">
              <Button
                variant="primary"
                size="sm"
                icon="plus"
                onClick={() => setEditing({ kind: 'factory', row: null })}
              >
                TAMBAH
              </Button>
            </div>
          </div>
          {factories.state === 'loading' ? <Loading /> : null}
          {factories.state === 'error' ? (
            <LoadError error={factories.error} onRetry={factories.reload} />
          ) : null}
          {factories.state === 'ok' && factories.data.length === 0 ? (
            <Empty>Belum ada factory. Tambah factory dulu.</Empty>
          ) : null}
          {factories.state === 'ok' && factories.data.length > 0 ? (
            <DataTable
              label="Daftar factory"
              columns={factoryColumns}
              rows={factories.data}
              rowKey={(f) => f.id}
              muted={(f) => !f.active}
              selected={(f) => f.id === chosen?.id}
              onRowClick={(f) => setChosenId(f.id)}
            />
          ) : null}
        </section>
        <section aria-label={chosen ? `Cell ${chosen.name}` : 'Cell'}>
          <div className="adm-toolbar">
            <h2 className="adm-subtitle">Cell {chosen ? chosen.name : ''}</h2>
            <div className="adm-toolbar__end">
              <Button
                variant="primary"
                size="sm"
                icon="plus"
                disabled={!chosen}
                onClick={() => setEditing({ kind: 'cell', row: null })}
              >
                TAMBAH
              </Button>
            </div>
          </div>
          {chosen && cells.state === 'loading' ? <Loading /> : null}
          {cells.state === 'error' ? (
            <LoadError error={cells.error} onRetry={cells.reload} />
          ) : null}
          {chosen && cells.state === 'ok' && cells.data.length === 0 ? (
            <Empty>Belum ada cell di {chosen.name}.</Empty>
          ) : null}
          {cells.state === 'ok' && cells.data.length > 0 ? (
            <DataTable
              label={`Daftar cell ${chosen?.name ?? ''}`}
              columns={cellColumns}
              rows={cells.data}
              rowKey={(c) => c.id}
              muted={(c) => !c.active}
            />
          ) : null}
        </section>
      </div>
      {editing?.kind === 'factory' ? (
        <FactoryDialog factory={editing.row} onClose={() => setEditing(null)} onSaved={saved} />
      ) : null}
      {editing?.kind === 'cell' && (editing.row || chosen) ? (
        <CellDialog
          cell={editing.row}
          factories={factories.data ?? []}
          defaultFactoryId={chosen?.id ?? 0}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      ) : null}
    </Pane>
  );
}

function useSave(onSaved: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async (write: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await write();
      toast(SAVED_MASTER);
      onSaved();
    } catch (e) {
      setError(asApiError(e));
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function FactoryDialog({
  factory,
  onClose,
  onSaved,
}: {
  factory: AdminFactory | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(factory?.name ?? '');
  const [active, setActive] = useState(factory?.active ?? true);
  const { busy, error, run } = useSave(onSaved);
  const trimmed = name.trim();
  const changes = factory
    ? {
        ...(trimmed !== factory.name ? { name: trimmed } : {}),
        ...(active !== factory.active ? { active } : {}),
      }
    : {};
  const dirty = factory ? Object.keys(changes).length > 0 : trimmed !== '';

  return (
    <FormDialog
      title={factory ? `Ubah factory: ${factory.name}` : 'Tambah factory'}
      dirty={dirty}
      busy={busy}
      error={error}
      submitDisabled={!trimmed || (factory !== null && !dirty)}
      onSubmit={() =>
        void run(() =>
          factory ? api.updateFactory(factory.id, changes) : api.createFactory(trimmed),
        )
      }
      onClose={onClose}
    >
      <TextField
        label="Nama factory"
        value={name}
        onChange={setName}
        maxLength={50}
        autoComplete="off"
        hint="Hanya factory bernama F <angka> yang dikirim ke tablet, misalnya F 3."
      />
      {factory ? <CheckField label="Aktif" checked={active} onChange={setActive} /> : null}
    </FormDialog>
  );
}

function CellDialog({
  cell,
  factories,
  defaultFactoryId,
  onClose,
  onSaved,
}: {
  cell: AdminCell | null;
  factories: AdminFactory[];
  defaultFactoryId: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState(cell?.code ?? '');
  const [factoryId, setFactoryId] = useState(cell?.factoryId ?? defaultFactoryId);
  const [active, setActive] = useState(cell?.active ?? true);
  const { busy, error, run } = useSave(onSaved);
  const trimmed = code.trim();
  const changes = cell
    ? {
        ...(trimmed !== cell.code ? { code: trimmed } : {}),
        ...(factoryId !== cell.factoryId ? { factoryId } : {}),
        ...(active !== cell.active ? { active } : {}),
      }
    : {};
  const dirty = cell ? Object.keys(changes).length > 0 : trimmed !== '';

  return (
    <FormDialog
      title={cell ? `Ubah cell: ${cell.code}` : 'Tambah cell'}
      dirty={dirty}
      busy={busy}
      error={error}
      submitDisabled={!trimmed || !factoryId || (cell !== null && !dirty)}
      onSubmit={() =>
        void run(() =>
          cell ? api.updateCell(cell.id, changes) : api.createCell(factoryId, trimmed),
        )
      }
      onClose={onClose}
    >
      <SelectInput
        label="Factory"
        value={String(factoryId)}
        onChange={(v) => setFactoryId(Number(v))}
        options={factories.map((f) => ({ value: String(f.id), label: f.name }))}
      />
      <TextField
        label="Kode cell"
        value={code}
        onChange={setCode}
        maxLength={50}
        autoComplete="off"
      />
      {cell ? <CheckField label="Aktif" checked={active} onChange={setActive} /> : null}
    </FormDialog>
  );
}
