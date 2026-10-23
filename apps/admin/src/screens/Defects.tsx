import { useRef, useState, type KeyboardEvent } from 'react';
import { Button, Chip, Pane } from '@m100/ui';
import type { ApiError } from '../api/client';
import * as api from '../api/endpoints';
import type { AdminAreaMap, AdminDefect, AdminMapRow } from '../api/types';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { DataTable, type Column } from '../common/DataTable';
import { SelectInput, TextField } from '../common/fields';
import { Empty, LoadError, Loading } from '../common/StateView';
import { SAVED_MASTER, useToast } from '../common/toast';
import { asApiError, useResource } from '../common/useResource';
import { ImportFlow } from './ImportFlow';

const TABS = [
  { id: 'defects', label: 'Defect' },
  { id: 'areas', label: 'Area, sub-area & family' },
  { id: 'map', label: 'Map' },
] as const;
type Tab = (typeof TABS)[number]['id'];

type Toggle =
  { kind: 'defect'; row: AdminDefect } | { kind: 'map'; row: AdminMapRow; label: string };

const yes = (active: boolean) => (active ? 'Ya' : 'Tidak');
const tone = (c: AdminDefect['classification']) =>
  c.toLowerCase() as 'minor' | 'major' | 'critical';

/**
 * A5 — read-mostly: defects D001–D098 (names exactly as in the list), areas / sub-areas / families, and the map.
 * Changes come from importing the mapping workbook; a defect or a map row can be switched off (doc 05 §20.5).
 */
export function Defects() {
  const [tab, setTab] = useState<Tab>('defects');
  const [toggle, setToggle] = useState<Toggle | null>(null);
  const [importing, setImporting] = useState(false);
  const defects = useResource(api.listDefects, 'defects');
  const map = useResource(api.getAreaMap, 'area-map');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onTabKey = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + TABS.length) % TABS.length;
    setTab(TABS[next]!.id);
    tabRefs.current[next]?.focus();
  };

  const reload = () => {
    defects.reload();
    map.reload();
  };

  return (
    <Pane label="Defect & area map">
      <div className="adm-toolbar">
        <h1 className="adm-title">Defect &amp; area map</h1>
        <div className="adm-toolbar__end">
          <Button size="sm" onClick={() => setImporting(true)}>
            IMPOR MAPPING
          </Button>
        </div>
      </div>
      <div className="adm-tabs" role="tablist" aria-label="Bagian">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className="adm-tab"
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'defects' ? (
          defects.state === 'loading' ? (
            <Loading />
          ) : defects.state === 'error' ? (
            <LoadError error={defects.error} onRetry={defects.reload} />
          ) : (
            <DefectTable
              rows={defects.data}
              onToggle={(row) => setToggle({ kind: 'defect', row })}
            />
          )
        ) : map.state === 'loading' ? (
          <Loading />
        ) : map.state === 'error' ? (
          <LoadError error={map.error} onRetry={map.reload} />
        ) : tab === 'areas' ? (
          <AreaTables map={map.data} />
        ) : (
          <MapTable
            map={map.data}
            defects={defects.data ?? []}
            onToggle={(row, label) => setToggle({ kind: 'map', row, label })}
          />
        )}
      </div>
      {toggle ? (
        <ToggleDialog
          toggle={toggle}
          onClose={() => setToggle(null)}
          onSaved={() => {
            setToggle(null);
            reload();
          }}
        />
      ) : null}
      {importing ? (
        <ImportFlow
          kind="area-map"
          title="Impor mapping area"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          hint="Workbook mapping (Footwear_Defect_Mapping_Database); paling besar 20 MB. Baris yang tidak ada di workbook tidak dihapus."
          onClose={() => setImporting(false)}
          onApplied={reload}
        />
      ) : null}
    </Pane>
  );
}

function DefectTable({
  rows,
  onToggle,
}: {
  rows: AdminDefect[];
  onToggle: (row: AdminDefect) => void;
}) {
  if (rows.length === 0) return <Empty>Belum ada defect. Impor workbook mapping.</Empty>;
  const columns: Column<AdminDefect>[] = [
    { key: 'id', header: 'ID', mono: true, cell: (d) => d.id },
    { key: 'name', header: 'Nama', cell: (d) => d.name },
    { key: 'class', header: 'Klasifikasi', cell: (d) => <Chip tone={tone(d.classification)} /> },
    {
      key: 'ctq',
      header: 'CTQ',
      cell: (d) => [d.ctqCategory, d.ctqCode].filter(Boolean).join(' · ') || '—',
    },
    { key: 'active', header: 'Aktif', cell: (d) => yes(d.active) },
    {
      key: 'toggle',
      header: '',
      cell: (d) => (
        <Button
          size="sm"
          onClick={() => onToggle(d)}
          aria-label={`${d.active ? 'Nonaktifkan' : 'Aktifkan'} ${d.id}`}
        >
          {d.active ? 'NONAKTIFKAN' : 'AKTIFKAN'}
        </Button>
      ),
    },
  ];
  return (
    <DataTable
      label="Daftar defect"
      columns={columns}
      rows={rows}
      rowKey={(d) => d.id}
      muted={(d) => !d.active}
    />
  );
}

function AreaTables({ map }: { map: AdminAreaMap }) {
  const areaName = new Map(map.areas.map((a) => [a.id, a.name]));
  type Area = AdminAreaMap['areas'][number];
  type SubArea = AdminAreaMap['subAreas'][number];
  type Family = AdminAreaMap['families'][number];
  const areaCols: Column<Area>[] = [
    { key: 'id', header: 'ID', mono: true, cell: (a) => a.id },
    { key: 'name', header: 'Area', cell: (a) => a.name },
    { key: 'sort', header: 'Urutan', numeric: true, cell: (a) => a.sort },
    { key: 'active', header: 'Aktif', cell: (a) => yes(a.active) },
  ];
  const subCols: Column<SubArea>[] = [
    { key: 'id', header: 'ID', mono: true, cell: (s) => s.id },
    { key: 'area', header: 'Area', cell: (s) => areaName.get(s.areaId) ?? s.areaId },
    { key: 'name', header: 'Sub-area', cell: (s) => s.name },
    { key: 'active', header: 'Aktif', cell: (s) => yes(s.active) },
  ];
  const familyCols: Column<Family>[] = [
    { key: 'id', header: 'ID', mono: true, cell: (f) => f.id },
    { key: 'name', header: 'Family', cell: (f) => f.name },
    { key: 'active', header: 'Aktif', cell: (f) => yes(f.active) },
  ];
  if (map.areas.length === 0) return <Empty>Belum ada area. Impor workbook mapping.</Empty>;
  return (
    <div className="adm-form">
      <h2 className="adm-subtitle">Area</h2>
      <DataTable
        label="Area"
        columns={areaCols}
        rows={map.areas}
        rowKey={(a) => a.id}
        muted={(a) => !a.active}
      />
      <h2 className="adm-subtitle">Sub-area</h2>
      <DataTable
        label="Sub-area"
        columns={subCols}
        rows={map.subAreas}
        rowKey={(s) => s.id}
        muted={(s) => !s.active}
      />
      <h2 className="adm-subtitle">Family</h2>
      <DataTable
        label="Family"
        columns={familyCols}
        rows={map.families}
        rowKey={(f) => f.id}
        muted={(f) => !f.active}
      />
    </div>
  );
}

function MapTable({
  map,
  defects,
  onToggle,
}: {
  map: AdminAreaMap;
  defects: AdminDefect[];
  onToggle: (row: AdminMapRow, label: string) => void;
}) {
  const [areaId, setAreaId] = useState(map.areas[0]?.id ?? '');
  const [search, setSearch] = useState('');
  const areaName = new Map(map.areas.map((a) => [a.id as string, a.name]));
  const subName = new Map(map.subAreas.map((s) => [s.id, s.name]));
  const familyName = new Map(map.families.map((f) => [f.id, f.name]));
  const defectName = new Map(defects.map((d) => [d.id as string, d.name]));

  const q = search.trim().toLowerCase();
  const rows = map.rows.filter(
    (r) =>
      (!areaId || r.areaId === areaId) &&
      (!q ||
        r.defectId.toLowerCase().includes(q) ||
        (defectName.get(r.defectId) ?? '').toLowerCase().includes(q)),
  );
  const label = (r: AdminMapRow) =>
    `${r.id}: ${areaName.get(r.areaId) ?? r.areaId} → ${subName.get(r.subAreaId) ?? r.subAreaId} → ${r.defectId}`;

  const columns: Column<AdminMapRow>[] = [
    { key: 'id', header: 'ID', mono: true, cell: (r) => r.id },
    { key: 'area', header: 'Area', cell: (r) => areaName.get(r.areaId) ?? r.areaId },
    { key: 'sub', header: 'Sub-area', cell: (r) => subName.get(r.subAreaId) ?? r.subAreaId },
    { key: 'family', header: 'Family', cell: (r) => familyName.get(r.familyId) ?? r.familyId },
    {
      key: 'defect',
      header: 'Defect',
      cell: (r) => (
        <>
          <span className="adm-mono">{r.defectId}</span> {defectName.get(r.defectId) ?? ''}
        </>
      ),
    },
    { key: 'active', header: 'Aktif', cell: (r) => yes(r.active) },
    {
      key: 'toggle',
      header: '',
      cell: (r) => (
        <Button
          size="sm"
          onClick={() => onToggle(r, label(r))}
          aria-label={`${r.active ? 'Nonaktifkan' : 'Aktifkan'} ${r.id}`}
        >
          {r.active ? 'NONAKTIFKAN' : 'AKTIFKAN'}
        </Button>
      ),
    },
  ];

  return (
    <div className="adm-form">
      <div className="adm-filters">
        <SelectInput
          label="Area"
          value={areaId}
          onChange={setAreaId}
          emptyLabel="Semua"
          options={map.areas.map((a) => ({ value: a.id, label: `${a.id} ${a.name}` }))}
        />
        <TextField
          label="Cari defect"
          type="search"
          value={search}
          onChange={setSearch}
          autoComplete="off"
        />
      </div>
      {rows.length === 0 ? (
        <Empty>Tidak ada baris map untuk pilihan ini.</Empty>
      ) : (
        <DataTable
          label="Map"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          muted={(r) => !r.active}
        />
      )}
    </div>
  );
}

function ToggleDialog({
  toggle,
  onClose,
  onSaved,
}: {
  toggle: Toggle;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const active = !toggle.row.active;
  const target = toggle.kind === 'defect' ? `${toggle.row.id} ${toggle.row.name}` : toggle.label;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      if (toggle.kind === 'defect') await api.updateDefect(toggle.row.id, active);
      else await api.updateMapRow(toggle.row.id, active);
      toast(SAVED_MASTER);
      onSaved();
    } catch (e) {
      setError(asApiError(e));
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      title={active ? 'Aktifkan' : 'Nonaktifkan'}
      confirmLabel={active ? 'AKTIFKAN' : 'NONAKTIFKAN'}
      danger={!active}
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    >
      <p>
        {active ? 'Aktifkan' : 'Nonaktifkan'} <b>{target}</b>?{' '}
        {active
          ? 'Tablet akan menampilkannya lagi.'
          : 'Tablet tidak menampilkannya lagi; submission lama tidak berubah.'}
      </p>
    </ConfirmDialog>
  );
}
