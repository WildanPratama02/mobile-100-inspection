import { useId, useMemo, useState, type ChangeEvent } from 'react';
import { Button, Notice, Pane } from '@m100/ui';
import { formatCount as countText, hasChanges, type Po } from '@m100/shared';
import { ApiError } from '../api/client';
import * as api from '../api/endpoints';
import type {
  AdminAreaMap,
  AdminCell,
  AdminDefect,
  AdminFactory,
  AdminPo,
  AdminPsiUser,
  AdminSubmissionDetail,
} from '../api/types';
import { navigate, routePath } from '../app/router';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { SelectInput, TextField } from '../common/fields';
import { UNSAVED_TEXT } from '../common/FormDialog';
import { Link } from '../common/Link';
import { LoadError, Loading, ProblemNotice } from '../common/StateView';
import { asApiError, useResource } from '../common/useResource';
import { useToast } from '../common/toast';
import { useUnsavedGuard } from '../common/unsaved';
import {
  changeLines,
  changeValue,
  type CorrectionForm,
  evaluate,
  type FormFinding,
  formFromDetail,
  newFinding,
  photoRows,
  problemsByField,
  requestFromForm,
} from '../correction/form';
import { moment, rate } from '../format';

/** The reason's length after trimming (doc 02 §4.4, ADR-024). */
const REASON_MIN = 10;
const REASON_MAX = 500;
const PHOTO_MAX_BYTES = 1024 * 1024;

interface Master {
  detail: AdminSubmissionDetail;
  users: AdminPsiUser[];
  factories: AdminFactory[];
  cells: AdminCell[];
  areaMap: AdminAreaMap;
  defects: AdminDefect[];
}

async function loadMaster(id: string): Promise<Master> {
  const [detail, users, factories, cells, areaMap, defects] = await Promise.all([
    api.getSubmission(id),
    api.listPsiUsers(),
    api.listFactories(),
    api.listCells(),
    api.getAreaMap(),
    api.listDefects(),
  ]);
  return { detail, users, factories, cells, areaMap, defects };
}

/** A1c — the correction form (doc 05 §20.3a, PRD FR-17). */
export function SubmissionCorrection({ id }: { id: string }) {
  const [round, setRound] = useState(0);
  const master = useResource(() => loadMaster(id), `${id}:${round}`);
  return (
    <Pane label="Koreksi submission">
      <Link className="adm-link" href={routePath({ name: 'submission', id })}>
        ← Detail submission
      </Link>
      {master.state === 'loading' ? <Loading /> : null}
      {master.state === 'error' ? <LoadError error={master.error} onRetry={master.reload} /> : null}
      {master.state === 'ok' ? (
        <Editor key={round} master={master.data} onReload={() => setRound((r) => r + 1)} />
      ) : null}
    </Pane>
  );
}

/** `D035 BOND GAP` */
function defectLabel(defects: ReadonlyMap<string, AdminDefect>, id: string): string {
  const d = defects.get(id);
  return d ? `${id} ${d.name}` : id;
}

function Editor({ master, onReload }: { master: Master; onReload: () => void }) {
  const { detail: d } = master;
  const toast = useToast();
  const [form, setForm] = useState<CorrectionForm>(() => formFromDetail(d));
  const [blobs, setBlobs] = useState<Map<string, Blob>>(() => new Map());
  const [previews, setPreviews] = useState<Map<string, string>>(() => new Map());
  const [poMaster, setPoMaster] = useState<Po | null>(null);
  const [poHits, setPoHits] = useState<AdminPo[] | null>(null);
  const [photoProblem, setPhotoProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState<'closed' | 'open' | 'busy'>('closed');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const [revisionId] = useState(() => crypto.randomUUID());
  const reasonId = useId();

  const defects = useMemo(
    () => new Map<string, AdminDefect>(master.defects.map((x) => [x.id, x])),
    [master.defects],
  );
  const lookup = useMemo(
    () => ({
      defect: (x: string) => {
        const found = defects.get(x);
        return found ? { classification: found.classification, name: found.name } : undefined;
      },
    }),
    [defects],
  );
  const rows = master.areaMap.rows;
  const familyOf = (subAreaId: string, defectId: string) =>
    rows.find((r) => r.subAreaId === subAreaId && r.defectId === defectId && r.active)?.familyId ??
    rows.find((r) => r.subAreaId === subAreaId && r.defectId === defectId)?.familyId ??
    '';
  const levelsOf = (username: string) =>
    master.users.filter((u) => u.username === username).map((u) => u.level);

  const evaluation = evaluate(form, d, {
    levelsOf,
    defects: lookup,
    poMaster,
    familyOf,
    now: new Date(),
  });
  const problems = problemsByField(evaluation.problems);
  const changed = evaluation.changes !== null && hasChanges(evaluation.changes);
  const canSave = changed && evaluation.problems.length === 0;
  useUnsavedGuard(changed && saving !== 'busy', (proceed) => setLeave(() => proceed));

  const set = (patch: Partial<CorrectionForm>) => setForm((f) => ({ ...f, ...patch }));
  const setFinding = (key: string, patch: Partial<FormFinding>) =>
    set({ findings: form.findings.map((f) => (f.key === key ? { ...f, ...patch } : f)) });

  const sameLevel = master.users
    .filter((u) => u.level === d.level)
    .map((u) => ({ value: u.username, label: u.active ? u.username : `${u.username} (nonaktif)` }));
  if (!sameLevel.some((o) => o.value === form.username)) {
    sameLevel.unshift({ value: form.username, label: `${form.username} (tidak di daftar)` });
  }
  const factory = master.factories.find((f) => f.name === form.factory);
  const cellOptions = master.cells
    .filter((c) => c.factoryId === factory?.id)
    .map((c) => ({ value: c.code, label: c.active ? c.code : `${c.code} (nonaktif)` }));

  const areas = master.areaMap.areas.map((a) => ({ value: a.id, label: `${a.id} ${a.name}` }));
  const subAreasOf = (areaId: string) =>
    master.areaMap.subAreas
      .filter((s) => s.areaId === areaId && rows.some((r) => r.subAreaId === s.id))
      .map((s) => ({ value: s.id, label: s.name }));
  const defectsOf = (subAreaId: string) =>
    [...new Set(rows.filter((r) => r.subAreaId === subAreaId).map((r) => r.defectId))].map((x) => ({
      value: x,
      label: defectLabel(defects, x),
    }));

  const photoList = photoRows(form, d, lookup);
  const originalPhoto = new Map(d.photos.map((p) => [p.defectId, p.url]));

  async function choosePhoto(defectId: string, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > PHOTO_MAX_BYTES) {
      setPhotoProblem(`Foto ${defectId} lebih dari 1 MB.`);
      return;
    }
    if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
      setPhotoProblem(`Foto ${defectId} bukan JPEG.`);
      return;
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    setPhotoProblem(null);
    setBlobs((m) => new Map(m).set(defectId, file));
    setPreviews((m) => new Map(m).set(defectId, URL.createObjectURL(file)));
    set({ photos: { ...form.photos, [defectId]: { kind: 'new', sha256, name: file.name } } });
  }

  async function searchPo() {
    try {
      setPoHits(await api.searchPos(form.po.trim()));
    } catch (e) {
      setError(asApiError(e));
    }
  }

  async function save() {
    setSaving('busy');
    setError(null);
    const request = requestFromForm(form, d, revisionId, reason.trim(), familyOf);
    const withFinding = new Set(form.findings.map((f) => f.defectId));
    const parts = new Map(
      [...blobs].filter(
        ([defectId]) => withFinding.has(defectId) && form.photos[defectId]?.kind === 'new',
      ),
    );
    try {
      const saved = await api.createRevision(d.id, request, parts);
      toast(
        `Koreksi disimpan (revisi ${saved.revisionNo}). Tablet PSI menerima koreksi saat online.`,
      );
      setSaving('closed');
      navigate(routePath({ name: 'submission', id: d.id }));
    } catch (e) {
      setSaving('closed');
      setError(asApiError(e));
    }
  }

  const show = (field: string, value: unknown): string =>
    changeValue(
      field,
      value,
      form.po === d.po ? d.orderQty : (poMaster?.orderQty ?? d.orderQty),
      moment,
    );
  const reasonLength = reason.trim().length;
  const conflict = error?.code === 'REVISION_CONFLICT';
  const totals = evaluation.totals;

  return (
    <>
      <h1 className="adm-title">Koreksi {d.displayNo}</h1>
      <p className="adm-meta">
        Koreksi menjadi revisi {d.latestRevisionNo + 1}. Data yang dikirim PSI tetap tersimpan.
      </p>
      {conflict ? (
        <Notice tone="danger">
          {error.detail}{' '}
          <Button size="sm" onClick={onReload}>
            MUAT ULANG
          </Button>
        </Notice>
      ) : error ? (
        <ProblemNotice error={error} />
      ) : null}

      <h2 className="adm-subtitle">Data</h2>
      <div className="adm-form adm-correction">
        <SelectInput
          label="PSI"
          value={form.username}
          onChange={(username) => set({ username })}
          options={sameLevel}
          problem={problems.get('username')}
          hint="Level tidak bisa dikoreksi."
        />
        <TextField label="Level" value={d.level} onChange={() => undefined} readOnly />
        <SelectInput
          label="Factory"
          value={form.factory}
          onChange={(factoryName) => set({ factory: factoryName, cell: '' })}
          options={master.factories.map((f) => ({
            value: f.name,
            label: f.active ? f.name : `${f.name} (nonaktif)`,
          }))}
        />
        <SelectInput
          label="Cell"
          value={form.cell}
          onChange={(cell) => set({ cell })}
          options={cellOptions}
          emptyLabel="Pilih cell"
          problem={problems.get('cell')}
        />
        <div className="adm-field">
          <TextField
            label="PO"
            value={form.po}
            onChange={(po) => {
              set({ po });
              setPoMaster(null);
              setPoHits(null);
            }}
            problem={problems.get('po')}
            hint={
              poMaster
                ? `${poMaster.article} · ${poMaster.model} · ${poMaster.destination} · Qty Order ${countText(poMaster.orderQty)}`
                : undefined
            }
          />
          {form.po.trim() !== d.po ? (
            <Button size="sm" onClick={() => void searchPo()} disabled={form.po.trim().length < 3}>
              CARI PO
            </Button>
          ) : null}
          {poHits ? (
            <ul className="adm-pick" aria-label="Hasil cari PO">
              {poHits.length === 0 ? <li>PO tidak ditemukan</li> : null}
              {poHits.map((p) => (
                <li key={p.po}>
                  <button
                    type="button"
                    className="adm-link adm-link--button"
                    onClick={() => {
                      set({ po: p.po });
                      setPoMaster(p);
                      setPoHits(null);
                    }}
                  >
                    {p.po} · {p.model} · {countText(p.orderQty)}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <SelectInput
          label="PO PARTIAL"
          value={form.partialOn ? 'yes' : 'no'}
          onChange={(v) => set({ partialOn: v === 'yes' })}
          options={[
            { value: 'no', label: 'Tidak' },
            { value: 'yes', label: 'Ya' },
          ]}
        />
        {form.partialOn ? (
          <>
            <TextField
              label="Nomor partial"
              inputMode="numeric"
              value={form.partialNo}
              onChange={(partialNo) => set({ partialNo })}
              problem={problems.get('partial.number')}
            />
            <TextField
              label="Qty partial"
              inputMode="numeric"
              value={form.partialQty}
              onChange={(partialQty) => set({ partialQty })}
              problem={problems.get('partial.qty')}
            />
          </>
        ) : null}
        <TextField
          label="Tanggal (WIB)"
          type="date"
          value={form.date}
          onChange={(date) => set({ date })}
          problem={problems.get('sealedAt')}
        />
        <TextField
          label="Jam (WIB)"
          type="time"
          value={form.time}
          onChange={(time) => set({ time })}
        />
      </div>

      <h2 className="adm-subtitle">Hitungan</h2>
      <div className="adm-form adm-correction">
        {d.countingRule === 'ADR-019' ? (
          <TextField
            label="QTY INSPECTION"
            inputMode="numeric"
            value={form.qtyInspection}
            onChange={(qtyInspection) => set({ qtyInspection })}
            problem={problems.get('counts.qtyInspection') ?? problems.get('counts')}
          />
        ) : (
          <TextField
            label="NO DEFECT"
            inputMode="numeric"
            value={form.noDefect}
            onChange={(noDefect) => set({ noDefect })}
            problem={problems.get('counts.noDefect') ?? problems.get('counts')}
          />
        )}
        <TextField
          label="INSPECTION REWORK QTY"
          inputMode="numeric"
          value={form.rework}
          onChange={(rework) => set({ rework })}
          problem={problems.get('counts.rework')}
        />
        <TextField
          label="B-GRADE (pasang)"
          inputMode="numeric"
          value={form.bGrade}
          onChange={(bGrade) => set({ bGrade })}
          problem={problems.get('counts.bGrade')}
        />
        <TextField
          label="REWORK AND APPROVED"
          inputMode="numeric"
          value={form.reworkApproved}
          onChange={(reworkApproved) => set({ reworkApproved })}
          problem={problems.get('counts.reworkApproved')}
        />
      </div>

      <h2 className="adm-subtitle">Temuan</h2>
      <div className="adm-table-wrap">
        <table className="adm-table" aria-label="Temuan koreksi">
          <thead>
            <tr>
              <th>Inspeksi</th>
              <th>Area</th>
              <th>Sub-area</th>
              <th>Defect</th>
              <th>Qty</th>
              <th>
                <span className="adm-meta">Aksi</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {form.findings.map((f, i) => (
              <tr key={f.key}>
                <td>
                  <SelectInput
                    label={`Inspeksi temuan ${i + 1}`}
                    value={f.inspectionType}
                    onChange={(v) =>
                      setFinding(f.key, { inspectionType: v as FormFinding['inspectionType'] })
                    }
                    options={[
                      { value: 'REWORK', label: 'REWORK' },
                      { value: 'B-GRADE', label: 'B-GRADE' },
                    ]}
                  />
                </td>
                <td>
                  <SelectInput
                    label={`Area temuan ${i + 1}`}
                    value={f.areaId}
                    onChange={(areaId) =>
                      setFinding(f.key, { areaId, subAreaId: '', defectId: '' })
                    }
                    options={areas}
                    emptyLabel="Pilih"
                  />
                </td>
                <td>
                  <SelectInput
                    label={`Sub-area temuan ${i + 1}`}
                    value={f.subAreaId}
                    onChange={(subAreaId) => setFinding(f.key, { subAreaId, defectId: '' })}
                    options={subAreasOf(f.areaId)}
                    emptyLabel="Pilih"
                  />
                </td>
                <td>
                  <SelectInput
                    label={`Defect temuan ${i + 1}`}
                    value={f.defectId}
                    onChange={(defectId) => setFinding(f.key, { defectId })}
                    options={defectsOf(f.subAreaId)}
                    emptyLabel="Pilih"
                    problem={problems.get(`findings.${i}`)}
                  />
                </td>
                <td>
                  <TextField
                    label={`Qty temuan ${i + 1}`}
                    inputMode="numeric"
                    value={f.qty}
                    onChange={(qty) => setFinding(f.key, { qty })}
                  />
                </td>
                <td>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => set({ findings: form.findings.filter((x) => x.key !== f.key) })}
                    aria-label={`Hapus temuan ${i + 1}`}
                  >
                    HAPUS
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button onClick={() => set({ findings: [...form.findings, newFinding()] })}>
        TAMBAH FINDING
      </Button>

      {d.level === 'PSI lv.2' ? (
        <>
          <h2 className="adm-subtitle">Foto</h2>
          {photoProblem ? <Notice tone="danger">{photoProblem}</Notice> : null}
          {problems.get('photos') ? <Notice tone="warning">{problems.get('photos')}</Notice> : null}
          <ul className="adm-photo-rows">
            {photoList.map(({ defectId, required }) => {
              const photo = form.photos[defectId];
              const src =
                photo?.kind === 'new'
                  ? previews.get(defectId)
                  : photo?.kind === 'keep'
                    ? originalPhoto.get(defectId)
                    : undefined;
              return (
                <li key={defectId} className="adm-photo-row">
                  {src ? <img src={src} alt={`Foto ${defectLabel(defects, defectId)}`} /> : null}
                  <span>
                    {defectLabel(defects, defectId)}
                    {!src && required ? <b className="adm-field__problem"> Foto wajib</b> : null}
                  </span>
                  <label className="m100-btn m100-btn--secondary m100-btn--sm adm-file">
                    GANTI
                    <input
                      type="file"
                      accept="image/jpeg"
                      onChange={(e) => void choosePhoto(defectId, e)}
                      aria-label={`Ganti foto ${defectId}`}
                    />
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      <h2 className="adm-subtitle">Hasil</h2>
      {totals ? (
        <dl className="adm-facts">
          {(
            [
              ['QTY INSPECTION', countText(totals.qtyInspection), countText(d.qtyInspection)],
              ['Qty Defect', countText(totals.qtyDefect), countText(d.qtyDefect)],
              ['A-Grade', countText(totals.qtyAGrade), countText(d.qtyAGrade)],
              ['B-Grade', countText(totals.qtyBGrade), countText(d.qtyBGrade)],
              [
                'DEFECT RATE',
                rate(totals.defectRate ?? 0, totals.qtyInspection),
                rate(d.defectRate, d.qtyInspection),
              ],
              [
                'PASS RATE (RFT)',
                rate(totals.passRate ?? 0, totals.qtyInspection),
                rate(d.rft, d.qtyInspection),
              ],
            ] as const
          ).map(([label, now, before]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                {now}
                {now !== before ? <span className="adm-meta"> (sebelumnya {before})</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="adm-meta">Lengkapi isian untuk melihat hasil.</p>
      )}

      <div className="adm-actions">
        <Button onClick={() => navigate(routePath({ name: 'submission', id: d.id }))}>BATAL</Button>
        <Button variant="primary" disabled={!canSave} onClick={() => setSaving('open')}>
          SIMPAN KOREKSI
        </Button>
      </div>

      {saving !== 'closed' ? (
        <ConfirmDialog
          title="Simpan koreksi?"
          confirmLabel="SIMPAN"
          busy={saving === 'busy'}
          confirmDisabled={reasonLength < REASON_MIN || reasonLength > REASON_MAX}
          onConfirm={() => void save()}
          onCancel={() => setSaving('closed')}
        >
          <ul className="adm-changes">
            {evaluation.changes
              ? changeLines(evaluation.changes, show).map((line) => <li key={line}>{line}</li>)
              : null}
          </ul>
          <div className="adm-field">
            <label htmlFor={reasonId}>Alasan koreksi</label>
            <textarea
              id={reasonId}
              className="adm-input adm-textarea"
              value={reason}
              maxLength={REASON_MAX + 50}
              onChange={(e) => setReason(e.target.value)}
              data-autofocus
            />
            <span className="adm-field__hint">
              {reasonLength} / {REASON_MAX} karakter, minimal {REASON_MIN}.
            </span>
          </div>
        </ConfirmDialog>
      ) : null}

      {leave ? (
        <ConfirmDialog
          title="Tinggalkan koreksi?"
          confirmLabel="TINGGALKAN"
          danger
          onConfirm={() => {
            const go = leave;
            setLeave(null);
            go();
          }}
          onCancel={() => setLeave(null)}
        >
          {UNSAVED_TEXT}
        </ConfirmDialog>
      ) : null}
    </>
  );
}
