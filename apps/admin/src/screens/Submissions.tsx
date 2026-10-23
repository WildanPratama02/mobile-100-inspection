import { useState, type FormEvent } from 'react';
import { Button, Pane } from '@m100/ui';
import * as api from '../api/endpoints';
import type { AdminSubmissionSummary, SubmissionFilter } from '../api/types';
import { navigate, replaceQuery, routePath, useLocation } from '../app/router';
import { DataTable, Pager, type Column } from '../common/DataTable';
import { SelectInput, TextField } from '../common/fields';
import { Link } from '../common/Link';
import { Empty, LoadError, Loading } from '../common/StateView';
import { useResource } from '../common/useResource';
import { formatCount, moment, rate, todayWib } from '../format';

export const EMPTY_TEXT = 'Tidak ada submission untuk filter ini.';

const FIELDS = ['from', 'to', 'factory', 'cell', 'username', 'po'] as const;

/**
 * The filter in the URL (so a reload or a shared link shows the same list). Without `from` / `to` in the URL both
 * are today (doc 05 §20.3); an emptied date stays empty: no limit on that side.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function filterFromQuery(query: URLSearchParams, today: string): SubmissionFilter {
  const get = (k: string) => query.get(k) ?? '';
  return {
    from: query.has('from') ? get('from') : today,
    to: query.has('to') ? get('to') : today,
    factory: get('factory'),
    cell: get('cell'),
    username: get('username'),
    po: get('po').trim(),
  };
}

/** The query of a filter and page; the dates are always written so an empty one is kept. */
// eslint-disable-next-line react-refresh/only-export-components
export function filterQuery(filter: SubmissionFilter, page: number): string {
  const params = new URLSearchParams();
  for (const k of FIELDS) if (k === 'from' || k === 'to' || filter[k]) params.set(k, filter[k]);
  if (page > 1) params.set('page', String(page));
  return `?${params.toString()}`;
}

function pageFromQuery(query: URLSearchParams): number {
  const n = Number(query.get('page'));
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

const COLUMNS: Column<AdminSubmissionSummary>[] = [
  {
    key: 'no',
    header: 'No.',
    mono: true,
    cell: (s) => (
      <Link className="adm-link" href={routePath({ name: 'submission', id: s.id })}>
        {s.displayNo}
      </Link>
    ),
  },
  { key: 'at', header: 'Waktu (WIB)', cell: (s) => moment(s.sealedAt) },
  {
    key: 'psi',
    header: 'PSI',
    cell: (s) => (
      <>
        {s.username} <span className="adm-meta">{s.level}</span>
      </>
    ),
  },
  { key: 'place', header: 'Factory/Cell', cell: (s) => `${s.factory} / ${s.cell}` },
  {
    key: 'po',
    header: 'PO',
    cell: (s) => (
      <>
        <span className="adm-mono">{s.po}</span>
        {s.partialText ? <span className="adm-meta"> {s.partialText}</span> : null}
      </>
    ),
  },
  {
    key: 'qi',
    header: 'QTY INSPECTION',
    numeric: true,
    cell: (s) => formatCount(s.qtyInspection),
  },
  { key: 'qd', header: 'Qty Defect', numeric: true, cell: (s) => formatCount(s.qtyDefect) },
  { key: 'qa', header: 'A-Grade', numeric: true, cell: (s) => formatCount(s.qtyAGrade) },
  { key: 'qb', header: 'B-Grade', numeric: true, cell: (s) => formatCount(s.qtyBGrade) },
  {
    key: 'rft',
    header: 'PASS RATE (RFT)',
    numeric: true,
    cell: (s) => rate(s.rft, s.qtyInspection),
  },
  {
    key: 'dr',
    header: 'DEFECT RATE',
    numeric: true,
    cell: (s) => rate(s.defectRate, s.qtyInspection),
  },
  { key: 'photos', header: 'Foto', numeric: true, cell: (s) => formatCount(s.photoCount) },
];

/** A1 — the read-only DataTable of submissions, home of the admin app (doc 05 §20.3). */
export function Submissions() {
  const { query } = useLocation();
  const filter = filterFromQuery(query, todayWib());
  const page = pageFromQuery(query);
  const key = filterQuery(filter, page);

  const list = useResource(() => api.listSubmissions(filter, page), key);

  return (
    <Pane label="Submission">
      <h1 className="adm-title">Submission</h1>
      <Filters
        key={key}
        initial={filter}
        onApply={(next) => replaceQuery(filterQuery(next, 1))}
        exportHref={api.exportCsvUrl(filter)}
      />
      {list.state === 'loading' ? <Loading /> : null}
      {list.state === 'error' ? <LoadError error={list.error} onRetry={list.reload} /> : null}
      {list.state === 'ok' && list.data.total === 0 ? <Empty>{EMPTY_TEXT}</Empty> : null}
      {list.state === 'ok' && list.data.total > 0 ? (
        <>
          <p className="adm-meta" aria-live="polite">
            {formatCount(list.data.total)} submission
          </p>
          <DataTable
            label="Daftar submission"
            columns={COLUMNS}
            rows={list.data.items}
            rowKey={(s) => s.id}
            onRowClick={(s) => navigate(routePath({ name: 'submission', id: s.id }))}
          />
          <Pager
            page={list.data.page}
            pageSize={list.data.pageSize}
            total={list.data.total}
            onPage={(p) => replaceQuery(filterQuery(filter, p))}
          />
        </>
      ) : null}
    </Pane>
  );
}

function Filters({
  initial,
  onApply,
  exportHref,
}: {
  initial: SubmissionFilter;
  onApply: (filter: SubmissionFilter) => void;
  exportHref: string;
}) {
  const [draft, setDraft] = useState(initial);
  const set = (k: keyof SubmissionFilter) => (v: string) =>
    setDraft((d) => (k === 'factory' ? { ...d, factory: v, cell: '' } : { ...d, [k]: v }));

  const factories = useResource(api.listFactories, 'factories');
  const factoryId = factories.data?.find((f) => f.name === draft.factory)?.id;
  const cells = useResource(
    () => (factoryId === undefined ? Promise.resolve([]) : api.listCells(factoryId)),
    `cells:${factoryId ?? ''}`,
  );
  const users = useResource(api.listPsiUsers, 'psi-users');
  const usernames = [...new Set((users.data ?? []).map((u) => u.username))].sort();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply(draft);
  };

  return (
    <form className="adm-filters" onSubmit={submit} aria-label="Filter submission">
      <TextField label="Tanggal dari" type="date" value={draft.from} onChange={set('from')} />
      <TextField label="Tanggal sampai" type="date" value={draft.to} onChange={set('to')} />
      <SelectInput
        label="Factory"
        value={draft.factory}
        onChange={set('factory')}
        emptyLabel="Semua"
        options={(factories.data ?? []).map((f) => ({ value: f.name, label: f.name }))}
      />
      <SelectInput
        label="Cell"
        value={draft.cell}
        onChange={set('cell')}
        emptyLabel="Semua"
        disabled={!draft.factory}
        options={(cells.data ?? []).map((c) => ({ value: c.code, label: c.code }))}
      />
      <SelectInput
        label="Nama PSI"
        value={draft.username}
        onChange={set('username')}
        emptyLabel="Semua"
        options={usernames.map((u) => ({ value: u, label: u }))}
      />
      <TextField label="PO" value={draft.po} onChange={set('po')} inputMode="search" />
      <Button type="submit" variant="primary" size="sm">
        TAMPILKAN
      </Button>
      <a className="m100-btn m100-btn--secondary m100-btn--sm" href={exportHref} download>
        EXPORT CSV
      </a>
    </form>
  );
}
