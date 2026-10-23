import { useId, useState } from 'react';
import { Button, Dialog, Notice } from '@m100/ui';
import { ApiError } from '../api/client';
import * as api from '../api/endpoints';
import type { ImportReport } from '../api/types';
import { DataTable, type Column } from '../common/DataTable';
import { Overlay } from '../common/Overlay';
import { ProblemNotice } from '../common/StateView';
import { useToast } from '../common/toast';
import { asApiError } from '../common/useResource';
import { formatCount } from '../format';

/** Upload limit of the imports (doc 03 §6). */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

type ReportError = ImportReport['errors'][number];

const ERROR_COLUMNS: Column<ReportError>[] = [
  { key: 'sheet', header: 'Sheet', cell: (e) => e.sheet },
  { key: 'row', header: 'Baris', numeric: true, cell: (e) => (e.row === undefined ? '—' : e.row) },
  { key: 'code', header: 'Kode', mono: true, cell: (e) => e.code },
  { key: 'message', header: 'Masalah', cell: (e) => <span className="adm-wrap">{e.message}</span> },
];

const STEPS = ['1. Pilih file', '2. Laporan', '3. Terapkan'];

/** `10 dibaca, 3 baru, 2 diubah, 5 dilewati` (doc 05 §20.5). */
// eslint-disable-next-line react-refresh/only-export-components
export function countsText(r: Pick<ImportReport, 'read' | 'inserted' | 'updated' | 'skipped'>) {
  return `${formatCount(r.read)} dibaca, ${formatCount(r.inserted)} baru, ${formatCount(r.updated)} diubah, ${formatCount(r.skipped)} dilewati`;
}

export interface ImportFlowProps {
  kind: api.ImportKind;
  title: string;
  /** File picker filter, e.g. `.csv,.xlsx`. */
  accept: string;
  hint: string;
  onClose: () => void;
  /** After a real run: reload the screen's data. */
  onApplied: () => void;
}

/**
 * The 3-step import of A4 and A5 (doc 05 §20.5): choosing a file sends it with `dryRun=true`; the report shows the
 * counts and the errors by row, and `Terapkan` stays disabled while any error exists (AC-14.3); `Terapkan` sends it
 * with `dryRun=false`.
 */
export function ImportFlow({ kind, title, accept, hint, onClose, onApplied }: ImportFlowProps) {
  const toast = useToast();
  const inputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState<'check' | 'apply' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const step = report ? 2 : 1;

  const choose = async (chosen: File | null) => {
    setReport(null);
    setError(null);
    setFile(chosen);
    if (!chosen) return;
    if (chosen.size > MAX_IMPORT_BYTES) {
      setError(
        new ApiError({ status: 413, code: 'PAYLOAD_TOO_LARGE', detail: 'File lebih dari 20 MB.' }),
      );
      return;
    }
    setBusy('check');
    try {
      setReport(await api.runImport(kind, chosen, true));
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!file) return;
    setBusy('apply');
    setError(null);
    try {
      const done = await api.runImport(kind, file, false);
      toast(`Impor selesai: ${countsText(done)}.`);
      onApplied();
      onClose();
    } catch (e) {
      setError(asApiError(e));
      setBusy(null);
    }
  };

  const close = () => {
    if (!busy) onClose();
  };
  const blocked = !report || report.errors.length > 0 || busy !== null;

  return (
    <Overlay onDismiss={close}>
      <Dialog title={title} onClose={close} wide>
        <div className="adm-form">
          <ol className="adm-steps" aria-label="Langkah impor">
            {STEPS.map((s, i) => (
              <li key={s} aria-current={i + 1 === step ? 'step' : undefined}>
                {s}
              </li>
            ))}
          </ol>
          <div className="adm-field">
            <label htmlFor={inputId}>File</label>
            <input
              id={inputId}
              className="adm-input"
              type="file"
              accept={accept}
              disabled={busy !== null}
              onChange={(e) => void choose(e.target.files?.[0] ?? null)}
            />
            <span className="adm-field__hint">{hint}</span>
          </div>
          {busy === 'check' ? (
            <p className="adm-state" role="status">
              Memeriksa file…
            </p>
          ) : null}
          {report ? <Report report={report} /> : null}
          {error ? <ProblemNotice error={error} /> : null}
          <div className="adm-actions">
            <Button onClick={close} disabled={busy !== null}>
              BATAL
            </Button>
            <Button variant="primary" disabled={blocked} onClick={() => void apply()}>
              {busy === 'apply' ? 'Menerapkan…' : 'Terapkan'}
            </Button>
          </div>
        </div>
      </Dialog>
    </Overlay>
  );
}

function Report({ report }: { report: ImportReport }) {
  const counts: [string, number][] = [
    ['Dibaca', report.read],
    ['Baru', report.inserted],
    ['Diubah', report.updated],
    ['Dilewati', report.skipped],
  ];
  return (
    <section aria-label="Laporan impor" className="adm-form">
      <dl className="adm-counts">
        {counts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{formatCount(v)}</dd>
          </div>
        ))}
      </dl>
      {report.errors.length > 0 ? (
        <>
          <Notice tone="danger">
            {formatCount(report.errors.length)} baris bermasalah. Perbaiki file lalu pilih lagi;
            tidak ada yang diterapkan selama masih ada masalah.
          </Notice>
          <DataTable
            label="Masalah per baris"
            columns={ERROR_COLUMNS}
            rows={report.errors}
            rowKey={(e) => `${e.sheet}:${e.row ?? ''}:${e.code}:${e.message}`}
          />
        </>
      ) : (
        <p className="adm-meta">Tidak ada masalah. Tekan Terapkan untuk menyimpan.</p>
      )}
      {report.warnings.length > 0 ? (
        <Notice tone="warning" title="Catatan:">
          <ul className="adm-problems">
            {report.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </section>
  );
}
