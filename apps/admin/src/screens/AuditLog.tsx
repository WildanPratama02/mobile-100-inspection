import { useId, useState, type FormEvent } from 'react';
import { Button, Pane } from '@m100/ui';
import * as api from '../api/endpoints';
import type { AuditFilter, AuditLogEntry } from '../api/types';
import { replaceQuery, useLocation } from '../app/router';
import { DataTable, Pager, type Column } from '../common/DataTable';
import { TextField } from '../common/fields';
import { Empty, LoadError, Loading } from '../common/StateView';
import { useResource } from '../common/useResource';
import { actorName, auditSummary, formatCount, moment } from '../format';

const COLUMNS: Column<AuditLogEntry>[] = [
  { key: 'at', header: 'Waktu (WIB)', cell: (e) => moment(e.at) },
  { key: 'actor', header: 'Admin', cell: (e) => actorName(e.actor) },
  { key: 'action', header: 'Aksi', mono: true, cell: (e) => e.action },
  {
    key: 'target',
    header: 'Target',
    cell: (e) => (e.entityId ? `${e.entity} #${e.entityId}` : e.entity),
  },
  {
    key: 'summary',
    header: 'Ringkasan',
    cell: (e) => <span className="adm-wrap">{auditSummary(e.details)}</span>,
  },
];

// eslint-disable-next-line react-refresh/only-export-components
export function auditFilterFromQuery(query: URLSearchParams): AuditFilter {
  return {
    from: query.get('from') ?? '',
    to: query.get('to') ?? '',
    actor: (query.get('actor') ?? '').trim(),
  };
}

function auditQuery(filter: AuditFilter, page: number): string {
  const params = new URLSearchParams();
  for (const k of ['from', 'to', 'actor'] as const) if (filter[k]) params.set(k, filter[k]);
  if (page > 1) params.set('page', String(page));
  const text = params.toString();
  return text ? `?${text}` : '?';
}

/** A7 — the audit log: read-only, filters for date and admin, newest first; no export in release 1. */
export function AuditLog() {
  const { query } = useLocation();
  const filter = auditFilterFromQuery(query);
  const pageNo = Number(query.get('page'));
  const page = Number.isInteger(pageNo) && pageNo >= 1 ? pageNo : 1;
  const key = auditQuery(filter, page);
  const log = useResource(() => api.readAuditLog(filter, page), key);

  return (
    <Pane label="Audit log">
      <h1 className="adm-title">Audit log</h1>
      <Filters key={key} initial={filter} onApply={(f) => replaceQuery(auditQuery(f, 1))} />
      {log.state === 'loading' ? <Loading /> : null}
      {log.state === 'error' ? <LoadError error={log.error} onRetry={log.reload} /> : null}
      {log.state === 'ok' && log.data.total === 0 ? (
        <Empty>Tidak ada catatan untuk filter ini.</Empty>
      ) : null}
      {log.state === 'ok' && log.data.total > 0 ? (
        <>
          <p className="adm-meta">{formatCount(log.data.total)} catatan</p>
          <DataTable
            label="Audit log"
            columns={COLUMNS}
            rows={log.data.items}
            rowKey={(e) => e.id}
          />
          <Pager
            page={log.data.page}
            pageSize={log.data.pageSize}
            total={log.data.total}
            onPage={(p) => replaceQuery(auditQuery(filter, p))}
          />
        </>
      ) : null}
    </Pane>
  );
}

function Filters({
  initial,
  onApply,
}: {
  initial: AuditFilter;
  onApply: (filter: AuditFilter) => void;
}) {
  const listId = useId();
  const [draft, setDraft] = useState(initial);
  const admins = useResource(api.listAdmins, 'admins');
  const actors = [...(admins.data ?? []).map((a) => `admin:${a.username}`), 'system'];
  const set = (k: keyof AuditFilter) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply({ ...draft, actor: draft.actor.trim() });
  };

  return (
    <form className="adm-filters" onSubmit={submit} aria-label="Filter audit log">
      <TextField label="Tanggal dari" type="date" value={draft.from} onChange={set('from')} />
      <TextField label="Tanggal sampai" type="date" value={draft.to} onChange={set('to')} />
      <TextField
        label="Admin"
        value={draft.actor}
        onChange={set('actor')}
        list={listId}
        autoComplete="off"
        hint="Misalnya admin:qip.digital, script:import-master, system."
      />
      <datalist id={listId}>
        {actors.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      <Button type="submit" variant="primary" size="sm">
        TAMPILKAN
      </Button>
    </form>
  );
}
