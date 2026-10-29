import { useState } from 'react';
import { Chip, Dialog, Pane, Top5Row } from '@m100/ui';
import * as api from '../api/endpoints';
import type { AdminFinding, AdminSubmissionDetail } from '../api/types';
import { BASE } from '../app/router';
import { DataTable, type Column } from '../common/DataTable';
import { Link } from '../common/Link';
import { Overlay } from '../common/Overlay';
import { Empty, LoadError, Loading } from '../common/StateView';
import { useResource } from '../common/useResource';
import {
  actorName,
  auditSummary,
  countingRuleLabel,
  formatCount,
  formatDate,
  moment,
  rate,
} from '../format';

const tone = (c: AdminFinding['classification']) =>
  c.toLowerCase() as 'minor' | 'major' | 'critical';

const FINDINGS: Column<AdminFinding>[] = [
  { key: 'area', header: 'Area', cell: (f) => f.areaName },
  { key: 'sub', header: 'Sub-area', cell: (f) => f.subAreaName },
  { key: 'family', header: 'Family', cell: (f) => f.familyName },
  {
    key: 'defect',
    header: 'Defect',
    cell: (f) => (
      <>
        <span className="adm-mono">{f.defectId}</span> {f.defectName}
      </>
    ),
  },
  {
    key: 'type',
    header: 'Inspeksi',
    cell: (f) => <Chip tone={f.inspectionType === 'REWORK' ? 'rework' : 'bgrade'} />,
  },
  { key: 'class', header: 'Klasifikasi', cell: (f) => <Chip tone={tone(f.classification)} /> },
  { key: 'qty', header: 'Qty', numeric: true, cell: (f) => formatCount(f.qty) },
];

/** A1b — one submission, read-only (AC-14.4): no edit, delete or void. */
export function SubmissionDetail({ id }: { id: string }) {
  const detail = useResource(() => api.getSubmission(id), id);
  return (
    <Pane label="Detail submission">
      <Link className="adm-link" href={BASE}>
        ← Daftar submission
      </Link>
      {detail.state === 'loading' ? <Loading /> : null}
      {detail.state === 'error' ? (
        <LoadError
          error={detail.error}
          onRetry={detail.error.status === 404 ? undefined : detail.reload}
        />
      ) : null}
      {detail.state === 'ok' ? <Body s={detail.data} /> : null}
    </Pane>
  );
}

function Body({ s }: { s: AdminSubmissionDetail }) {
  const [photo, setPhoto] = useState<{ id: number; label: string } | null>(null);
  const names = new Map(s.findings.map((f) => [f.defectId, f.defectName]));

  const facts: [string, string][] = [
    ['Waktu (WIB)', moment(s.sealedAt)],
    ['Diterima', moment(s.receivedAt)],
    ['PSI', `${s.username} (${s.level})`],
    ['Factory/Cell', `${s.factory} / ${s.cell}`],
    ['PO', s.po],
    ['PO PARTIAL', s.partialText ?? 'Tidak'],
    ['Article', s.article],
    ['Model', s.model],
    ['Destination', s.destination],
    ['Order qty', formatCount(s.orderQty)],
    ['PODD', formatDate(s.podd)],
    ['CRD', formatDate(s.crd)],
    ['QTY INSPECTION', formatCount(s.qtyInspection)],
    ['Qty Defect', formatCount(s.qtyDefect)],
    ['A-Grade', formatCount(s.qtyAGrade)],
    ['B-Grade', formatCount(s.qtyBGrade)],
    ['PASS RATE (RFT)', rate(s.rft, s.qtyInspection)],
    ['DEFECT RATE', rate(s.defectRate, s.qtyInspection)],
    ['Aturan hitung', countingRuleLabel(s.countingRule)],
    ['REWORK (pasang)', formatCount(s.counts.rework)],
    ['B-GRADE (pasang)', formatCount(s.counts.bGrade)],
    ...(s.countingRule === 'ADR-008'
      ? [['NO DEFECT', formatCount(s.counts.noDefect)] as [string, string]]
      : []),
    ['Versi app', s.appVersion ?? '—'],
  ];

  return (
    <>
      <h1 className="adm-title">{s.displayNo}</h1>
      <dl className="adm-facts">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>

      <h2 className="adm-subtitle">TOP 5 DEFECT</h2>
      {s.top5.length === 0 ? (
        <Empty>Tidak ada defect.</Empty>
      ) : (
        <div className="adm-top5">
          {s.top5.map((t) => (
            <Top5Row
              key={t.defectId}
              no={t.rank}
              name={t.defectName}
              classification={tone(t.classification)}
              qty={t.qty}
            />
          ))}
        </div>
      )}

      <h2 className="adm-subtitle">Foto</h2>
      {s.photos.length === 0 ? (
        <Empty>Tidak ada foto.</Empty>
      ) : (
        <div className="adm-photos">
          {s.photos.map((p) => {
            const label = `${p.defectId} ${names.get(p.defectId) ?? ''}`.trim();
            return (
              <button
                key={p.id}
                type="button"
                className="adm-thumb"
                onClick={() => setPhoto({ id: p.id, label })}
                aria-label={`Foto ${label}, perbesar`}
              >
                <img src={api.photoUrl(p.id)} alt="" loading="lazy" />
                <span>{p.defectId}</span>
              </button>
            );
          })}
        </div>
      )}

      <h2 className="adm-subtitle">Temuan</h2>
      {s.findings.length === 0 ? (
        <Empty>Tidak ada temuan.</Empty>
      ) : (
        <DataTable
          label="Temuan"
          columns={FINDINGS}
          rows={s.findings}
          rowKey={(f) => `${f.inspectionType}:${f.areaId}:${f.subAreaId}:${f.defectId}`}
        />
      )}

      <h2 className="adm-subtitle">Audit trail</h2>
      {s.audit.length === 0 ? (
        <Empty>Belum ada catatan audit untuk submission ini.</Empty>
      ) : (
        <ul>
          {s.audit.map((a) => (
            <li key={a.id}>
              {moment(a.at)} · {actorName(a.actor)} · {a.action} · {auditSummary(a.details)}
            </li>
          ))}
        </ul>
      )}

      {photo ? (
        <Overlay onDismiss={() => setPhoto(null)}>
          <Dialog title={`Foto ${photo.label}`} onClose={() => setPhoto(null)} wide>
            <img className="adm-photo-large" src={api.photoUrl(photo.id)} alt={photo.label} />
          </Dialog>
        </Overlay>
      ) : null}
    </>
  );
}
