import { useState } from 'react';
import { Button, Chip, Dialog, Notice, Pane, Top5Row } from '@m100/ui';
import { API_BASE } from '../api/client';
import * as api from '../api/endpoints';
import type { AdminFinding, AdminSubmissionDetail, RevisionHistoryEntry } from '../api/types';
import { BASE, navigate, routePath, useLocation } from '../app/router';
import { changeLines, changeValue } from '../correction/form';
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
  photoRuleLabel,
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

/** `?revision=<n>` of the detail: an earlier version (ADR-024); none for the effective one. */
function revisionOf(query: URLSearchParams): number | undefined {
  const text = query.get('revision');
  return text !== null && /^\d+$/.test(text) ? Number(text) : undefined;
}

/**
 * A1b — one submission: its effective version, or an earlier one with `?revision=<n>`. No delete or void (AC-14.4);
 * KOREKSI opens the correction form (A1c, ADR-024), and the history lists every version.
 */
export function SubmissionDetail({ id }: { id: string }) {
  const { query } = useLocation();
  const revision = revisionOf(query);
  const detail = useResource(() => api.getSubmission(id, revision), `${id}:${revision ?? ''}`);
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
  const [photo, setPhoto] = useState<{ url: string; label: string } | null>(null);
  const history = useResource(() => api.getRevisions(s.id), `${s.id}:${s.latestRevisionNo}`);
  const newest = s.revisionNo === s.latestRevisionNo;
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
    ['INSPECTION REWORK QTY', formatCount(s.counts.rework)],
    ['REWORK AND APPROVED', formatCount(s.counts.reworkApproved)],
    ['B-GRADE (pasang)', formatCount(s.counts.bGrade)],
    ['Aturan foto', photoRuleLabel(s.photoRule)],
    ...(s.countingRule === 'ADR-008'
      ? [['NO DEFECT', formatCount(s.counts.noDefect)] as [string, string]]
      : []),
    ['Versi app', s.appVersion ?? '—'],
  ];

  return (
    <>
      <div className="adm-toolbar">
        <h1 className="adm-title">
          {s.displayNo}
          {s.revisionNo > 0 ? <Chip tone="neutral"> Rev {s.revisionNo}</Chip> : null}
        </h1>
        {newest ? (
          <Button
            variant="primary"
            onClick={() => navigate(routePath({ name: 'submission-correction', id: s.id }))}
          >
            KOREKSI
          </Button>
        ) : null}
      </div>
      {!newest ? (
        <Notice tone="warning" title={`Revisi ${s.revisionNo}, bukan versi terbaru`}>
          <Link className="adm-link" href={routePath({ name: 'submission', id: s.id })}>
            Ke versi terbaru (revisi {s.latestRevisionNo})
          </Link>
        </Notice>
      ) : null}
      {s.correctedAt ? (
        <Notice tone="warning">
          Dikoreksi {moment(s.correctedAt)} oleh {s.correctedBy} (revisi {s.revisionNo}):{' '}
          {s.correctionReason}
        </Notice>
      ) : null}
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
                onClick={() => setPhoto({ url: photoSrc(p), label })}
                aria-label={`Foto ${label}, perbesar`}
              >
                <img src={photoSrc(p)} alt="" loading="lazy" />
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

      <h2 className="adm-subtitle">Riwayat</h2>
      {history.state === 'loading' ? <Loading /> : null}
      {history.state === 'error' ? (
        <LoadError error={history.error} onRetry={history.reload} />
      ) : null}
      {history.state === 'ok' ? <History entries={history.data.items} s={s} /> : null}

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
            <img className="adm-photo-large" src={photo.url} alt={photo.label} />
          </Dialog>
        </Overlay>
      ) : null}
    </>
  );
}

/** The versions of the submission (doc 05 §20.3): revision 0 by the PSI, then each correction with its changes. */
function History({ entries, s }: { entries: RevisionHistoryEntry[]; s: AdminSubmissionDetail }) {
  const show = (field: string, value: unknown): string =>
    changeValue(field, value, s.orderQty, moment);
  return (
    <ol className="adm-history">
      {entries.map((e) => {
        const href = `${routePath({ name: 'submission', id: s.id })}${
          e.revisionNo === s.latestRevisionNo ? '' : `?revision=${e.revisionNo}`
        }`;
        const current = e.revisionNo === s.revisionNo;
        return (
          <li key={e.revisionNo} aria-current={current ? 'true' : undefined}>
            <Link className="adm-link" href={href}>
              {e.revisionNo === 0 ? `Dikirim PSI ${e.by}` : `Revisi ${e.revisionNo} oleh ${e.by}`}
            </Link>{' '}
            <span className="adm-meta">{moment(e.at)}</span>
            {e.reason ? <p>{e.reason}</p> : null}
            {e.changes ? (
              <ul>
                {changeLines(e.changes, show).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Where a photo loads from: the URL the API gives (an original or a correction's photo, ADR-024); an API from
 * before ADR-024 sends no `url`, and its photos are all originals.
 */
function photoSrc(p: { id: number; url?: string }): string {
  return p.url ?? `${API_BASE}/photos/${p.id}`;
}
