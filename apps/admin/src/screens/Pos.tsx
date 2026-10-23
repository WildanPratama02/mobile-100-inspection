import { useState, type FormEvent } from 'react';
import { Button, Pane } from '@m100/ui';
import type { ApiError } from '../api/client';
import * as api from '../api/endpoints';
import type { AdminPo, AdminPoInput } from '../api/types';
import { DataTable, type Column } from '../common/DataTable';
import { CheckField, TextField } from '../common/fields';
import { FormDialog } from '../common/FormDialog';
import { Empty, LoadError, Loading } from '../common/StateView';
import { SAVED_MASTER, useToast } from '../common/toast';
import { asApiError, useResource } from '../common/useResource';
import { formatCount, formatDate } from '../format';
import { ImportFlow } from './ImportFlow';

export const MIN_QUERY = 3;

/** A4 — search (PO / article / model), up to 50 hits, add, edit one PO, import (doc 05 §20.5). */
export function Pos() {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<AdminPo | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const hits = useResource(
    () => (q.length >= MIN_QUERY ? api.searchPos(q) : Promise.resolve(null)),
    q,
  );

  const search = (event: FormEvent) => {
    event.preventDefault();
    setQ(draft.trim());
  };

  const columns: Column<AdminPo>[] = [
    { key: 'po', header: 'PO', mono: true, cell: (p) => p.po },
    { key: 'article', header: 'Article', cell: (p) => p.article },
    { key: 'model', header: 'Model', cell: (p) => p.model },
    { key: 'destination', header: 'Destination', cell: (p) => p.destination },
    { key: 'qty', header: 'Order qty', numeric: true, cell: (p) => formatCount(p.orderQty) },
    { key: 'podd', header: 'PODD', cell: (p) => formatDate(p.podd) },
    { key: 'crd', header: 'CRD', cell: (p) => formatDate(p.crd) },
    {
      key: 'finished',
      header: 'Finished',
      cell: (p) => (p.finished === null ? '—' : p.finished ? 'Ya' : 'Tidak'),
    },
    { key: 'active', header: 'Aktif', cell: (p) => (p.active ? 'Ya' : 'Tidak') },
    {
      key: 'edit',
      header: '',
      cell: (p) => (
        <Button size="sm" onClick={() => setEditing(p)} aria-label={`Ubah PO ${p.po}`}>
          UBAH
        </Button>
      ),
    },
  ];

  return (
    <Pane label="PO">
      <div className="adm-toolbar">
        <h1 className="adm-title">PO</h1>
        <div className="adm-toolbar__end">
          <Button size="sm" onClick={() => setImporting(true)}>
            IMPOR CSV/XLSX
          </Button>
          <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing('new')}>
            TAMBAH
          </Button>
        </div>
      </div>
      <form className="adm-toolbar" onSubmit={search} role="search" aria-label="Cari PO">
        <TextField
          label="Cari PO / article / model"
          type="search"
          value={draft}
          onChange={setDraft}
          autoComplete="off"
          maxLength={40}
          hint={`Minimal ${MIN_QUERY} karakter; paling banyak 50 hasil.`}
        />
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={draft.trim().length < MIN_QUERY}
        >
          CARI
        </Button>
      </form>
      {hits.state === 'loading' ? <Loading /> : null}
      {hits.state === 'error' ? <LoadError error={hits.error} onRetry={hits.reload} /> : null}
      {hits.state === 'ok' && hits.data === null ? (
        <Empty>Ketik nomor PO, article atau model lalu tekan CARI.</Empty>
      ) : null}
      {hits.state === 'ok' && hits.data?.length === 0 ? (
        <Empty
          action={
            <Button size="sm" onClick={() => setEditing('new')}>
              TAMBAH
            </Button>
          }
        >
          Tidak ada PO untuk “{q}”.
        </Empty>
      ) : null}
      {hits.state === 'ok' && hits.data && hits.data.length > 0 ? (
        <DataTable
          label="Hasil pencarian PO"
          columns={columns}
          rows={hits.data}
          rowKey={(p) => p.po}
          muted={(p) => !p.active}
        />
      ) : null}
      {editing ? (
        <PoDialog
          po={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            if (q.length >= MIN_QUERY) hits.reload();
            else {
              setDraft(saved.po);
              setQ(saved.po);
            }
          }}
        />
      ) : null}
      {importing ? (
        <ImportFlow
          kind="pos"
          title="Impor PO"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          hint="CSV atau XLSX (sheet ALL_PO_MASTER), kolom PO, ARTICLE, MODEL, DESTINATION, ORDER QTY, PODD, CRD; paling besar 20 MB."
          onClose={() => setImporting(false)}
          onApplied={() => {
            if (q.length >= MIN_QUERY) hits.reload();
          }}
        />
      ) : null}
    </Pane>
  );
}

interface PoForm {
  po: string;
  article: string;
  model: string;
  destination: string;
  orderQty: string;
  podd: string;
  crd: string;
  active: boolean;
}

function formOf(po: AdminPo | null): PoForm {
  return {
    po: po?.po ?? '',
    article: po?.article ?? '',
    model: po?.model ?? '',
    destination: po?.destination ?? '',
    orderQty: po ? String(po.orderQty) : '',
    podd: po?.podd ?? '',
    crd: po?.crd ?? '',
    active: po?.active ?? true,
  };
}

const QTY = /^[1-9][0-9]{0,8}$/;

function PoDialog({
  po,
  onClose,
  onSaved,
}: {
  po: AdminPo | null;
  onClose: () => void;
  onSaved: (po: AdminPo) => void;
}) {
  const toast = useToast();
  const initial = formOf(po);
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const set =
    <K extends keyof PoForm>(k: K) =>
    (v: PoForm[K]) =>
      setForm((f) => ({ ...f, [k]: v }));

  const qtyOk = QTY.test(form.orderQty.trim());
  const changes: AdminPoInput = {};
  if (form.article !== initial.article) changes.article = form.article;
  if (form.model !== initial.model) changes.model = form.model;
  if (form.destination !== initial.destination) changes.destination = form.destination;
  if (form.orderQty.trim() !== initial.orderQty) changes.orderQty = Number(form.orderQty.trim());
  if (form.podd !== initial.podd) changes.podd = form.podd || null;
  if (form.crd !== initial.crd) changes.crd = form.crd || null;
  if (form.active !== initial.active) changes.active = form.active;
  const dirty = Object.keys(changes).length > 0 || form.po !== initial.po;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = po
        ? await api.updatePo(po.po, changes)
        : await api.createPo({
            po: form.po.trim(),
            article: form.article,
            model: form.model,
            destination: form.destination,
            orderQty: Number(form.orderQty.trim()),
            podd: form.podd || null,
            crd: form.crd || null,
          });
      toast(SAVED_MASTER);
      onSaved(saved);
    } catch (e) {
      setError(asApiError(e));
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title={po ? `Ubah PO ${po.po}` : 'Tambah PO'}
      dirty={dirty}
      busy={busy}
      error={error}
      wide
      submitDisabled={!qtyOk || (po ? !dirty : !form.po.trim())}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      {po ? null : (
        <TextField
          label="PO"
          value={form.po}
          onChange={set('po')}
          maxLength={40}
          autoComplete="off"
          hint="Nomor PO tidak bisa diubah setelah disimpan."
        />
      )}
      <TextField label="Article" value={form.article} onChange={set('article')} maxLength={200} />
      <TextField label="Model" value={form.model} onChange={set('model')} maxLength={200} />
      <TextField
        label="Destination"
        value={form.destination}
        onChange={set('destination')}
        maxLength={200}
      />
      <TextField
        label="Order qty"
        value={form.orderQty}
        onChange={set('orderQty')}
        inputMode="numeric"
        problem={form.orderQty && !qtyOk ? 'Bilangan bulat, minimal 1.' : undefined}
      />
      <TextField label="PODD" type="date" value={form.podd} onChange={set('podd')} />
      <TextField label="CRD" type="date" value={form.crd} onChange={set('crd')} />
      {po ? (
        <>
          <p className="adm-meta">
            Finished: {po.finished === null ? '—' : po.finished ? 'Ya' : 'Tidak'} (belum bisa
            diubah, OQ-06). Sumber: {po.source}
          </p>
          <CheckField label="Aktif" checked={form.active} onChange={set('active')} />
        </>
      ) : null}
    </FormDialog>
  );
}
