/**
 * S3 Home (doc 05 §8): the PO info strip and account in the header, the PO list, ALL DEFECT, the results box
 * and the bottom row. Everything shown is derived from the selected PO's open session with `@m100/shared`
 * (FR-04, FR-05); nothing here counts by itself.
 *
 * For PSI lv.2 every ALL DEFECT row carries the photo control (FR-10, ADR-022, doc 05 §8.3, §12); PSI lv.1 gets
 * none. The results box also has INSPECTION REWORK QTY and REWORK AND APPROVED (FR-16, doc 05 §8.1, §10c).
 * EXPORT PDF / EXPORT EXCEL make a file of the PO's sealed submission in the outbox, so they are only enabled
 * once SUBMIT PO has sealed one (FR-12); SUBMIT PO runs the checks and the confirmation of S8, seals the session
 * into the outbox and hands it to the outbox sender (FR-11, doc 05 §13); the header counts the PSI's waiting
 * submissions (AC-11.3). HAPUS DATA DEFECT empties the PO's open session.
 */
import { useRef, useState, type ChangeEvent } from 'react';
import {
  allDefects,
  countingMode,
  emptySession,
  findings,
  formatCount,
  formatPartial,
  formatRate,
  formatTime,
  missingPhotos,
  takesPhotos,
  totals,
  type Classification,
  type CountingMode,
  type DefectId,
  type MappingIndex,
  type RankedDefect,
} from '@m100/shared';
import { Logo } from '../app/Logo';
import { areaLabels, useMapping } from '../app/mapping';
import { Overlay } from '../app/Overlay';
import { useToast } from '../app/toastContext';
import { useOnline } from '../app/useOnline';
import type { Auth, PhotoRow, PoRow } from '../db/schema';
import { exportFile, type ExportFormat } from '../export/exportFile';
import { sealedExport } from '../export/report';
import { listOutboxPhotos } from '../db/repo';
import { saveFile } from '../export/saveFile';
import { useOutboxSender } from '../outbox/useOutboxSender';
import { toJpeg } from '../photos/resize';
import { usePhotoUrl } from '../photos/usePhotoUrl';
import {
  hasOpenData,
  selectedPo,
  submitBlock,
  useAppStore,
  useAppStoreApi,
  waitingCount,
  type PoSession,
} from '../state/store';
import {
  Button,
  Chip,
  CountBadge,
  Dialog,
  Icon,
  Notice,
  Pane,
  POListItem,
  StatRow,
  Top5Row,
  type Classification as ChipClassification,
} from '../ui';
import { AddPoDialog } from './AddPoDialog';
import { NO_PATH } from './drilldown';
import { MissingPhotosDialog } from './MissingPhotosDialog';
import { PartialDialog } from './PartialDialog';
import { PhotoViewDialog } from './PhotoViewDialog';
import { ReworkApprovedDialog } from './ReworkApprovedDialog';
import { SettingsDialog } from './SettingsDialog';
import {
  SubmitActiveDialog,
  SubmitConfirmDialog,
  SubmitEmptyDialog,
  SubmitNoPairsDialog,
  SubmitReworkApprovedDialog,
} from './SubmitDialogs';
import { QtyInspectionDialog } from './QtyInspectionDialog';
import { QtySubmitDialog } from './QtySubmitDialog';
import { qtyNotice } from './qtyInspectionNotice';
import './screens.css';

/** U3: Defect Rate shows `bad` above this. A display aid only, not a business rule; change it here. */
export const DEFECT_RATE_BAD_ABOVE = 0.05;

/** Doc 05 §8.4: a long press this long on a PO without data offers to remove it (AC-03.4). */
export const LONG_PRESS_MS = 600;

/** One dialog at a time (doc 05 §2). */
type Open =
  | { kind: 'menu' }
  | { kind: 'add' }
  | { kind: 'partial' }
  | { kind: 'remove'; po: string }
  | { kind: 'photo'; defectId: DefectId }
  | { kind: 'missing-photos'; names: string[] }
  | { kind: 'submit-active' }
  | { kind: 'submit-no-pairs' }
  | { kind: 'submit-empty' }
  | { kind: 'submit-rework-approved' }
  | { kind: 'rework-approved' }
  | { kind: 'submit-confirm' }
  | { kind: 'clear-data' };
type QtyOpen = { kind: 'qty' } | { kind: 'submit-qty'; issue: 'BELOW' | 'ABOVE' | 'IMPOSSIBLE' };

export interface HomeScreenProps {
  auth: Auth;
}

export function HomeScreen({ auth }: HomeScreenProps) {
  const online = useOnline();
  const mapping = useMapping();
  const pos = useAppStore((s) => s.pos);
  const sessions = useAppStore((s) => s.sessions);
  const po = useAppStore(selectedPo);
  const setView = useAppStore((s) => s.setView);
  const removePo = useAppStore((s) => s.removePo);
  const savePhoto = useAppStore((s) => s.savePhoto);
  const removePhoto = useAppStore((s) => s.removePhoto);
  const submitPo = useAppStore((s) => s.submitPo);
  const clearSessionData = useAppStore((s) => s.clearSessionData);
  const waiting = useAppStore(waitingCount);
  const outbox = useAppStore((s) => s.outbox);
  const db = useAppStoreApi().db;
  const sender = useOutboxSender();
  const toast = useToast();
  const [open, setOpen] = useState<Open | QtyOpen | null>(null);
  const close = () => setOpen(null);

  const session = po ? sessions[po.po] : undefined;
  const active = session?.state.active ?? null;

  // S7a (doc 05 §12.1): the system camera through a file input; the defect it is for waits here.
  const photos = takesPhotos(auth.level);
  const camera = useRef<HTMLInputElement>(null);
  const shooting = useRef<{ po: string; defectId: DefectId } | null>(null);

  const takePhoto = (defectId: DefectId) => {
    if (!po) return;
    shooting.current = { po: po.po, defectId };
    camera.current?.click();
  };

  const onPhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Cleared so the same file can be picked again; a cancelled camera changes nothing.
    input.value = '';
    const target = shooting.current;
    shooting.current = null;
    if (!file || !target) return;
    try {
      await savePhoto(target.po, target.defectId, await toJpeg(file));
      setOpen((current) => (current?.kind === 'photo' ? null : current));
      toast('Foto tersimpan');
    } catch (error) {
      console.error(error);
      toast('Foto gagal disimpan. Coba lagi.', 'error');
    }
  };

  // One export at a time: a second tap while the file is being made does nothing.
  const exporting = useRef(false);

  // Exports describe the PO's sealed submission, never the open session; there is nothing until SUBMIT PO.
  const sealed = po ? outbox.find((o) => o.po === po.po) : undefined;

  /**
   * Makes the file of the sealed submission (FR-12). Reads the outbox only, so it changes nothing (AC-12.4); the
   * file carries the submission's inspection date, never this moment (AC-12.3).
   */
  const onExport = async (format: ExportFormat) => {
    if (!po || !sealed || exporting.current) return;
    exporting.current = true;
    try {
      const photoBlobs = await listOutboxPhotos(db, sealed.submissionUuid);
      const report = sealedExport({ po, item: sealed, mapping, photoBlobs });
      const file = await exportFile(format, report);
      if ((await saveFile(file.name, file.blob)) === 'saved') toast(`File dibuat: ${file.name}`);
    } catch (error) {
      console.error(error);
      toast('File gagal dibuat. Coba lagi.', 'error');
    } finally {
      exporting.current = false;
    }
  };

  /** S8 step 1 (doc 05 §13.1): the first failing check opens its dialog, otherwise the confirmation. */
  const onSubmit = () => {
    if (!po) return;
    const block = submitBlock(auth.level, session, mapping, po);
    if (!block) setOpen({ kind: 'submit-confirm' });
    else if (block.kind === 'ACTIVE') setOpen({ kind: 'submit-active' });
    else if (block.kind === 'NO_PAIRS') setOpen({ kind: 'submit-no-pairs' });
    else if (block.kind === 'EMPTY') setOpen({ kind: 'submit-empty' });
    else if (block.kind === 'BELOW' || block.kind === 'ABOVE' || block.kind === 'IMPOSSIBLE')
      setOpen({ kind: 'submit-qty', issue: block.kind });
    else if (block.kind === 'REWORK_APPROVED_ABOVE') setOpen({ kind: 'submit-rework-approved' });
    else if (block.kind === 'PHOTOS_MISSING') {
      const names = block.defects.map((d) => mapping.defect(d.defectId)?.name ?? d.defectId);
      setOpen({ kind: 'missing-photos', names });
    }
  };

  /**
   * KIRIM (doc 05 §13.3): the session is sealed on the tablet and Home shows the PO's new empty session at once;
   * Home never waits for the answer. Online, "Sedang dikirim." until the first attempt ends: "PO terkirim HH:mm"
   * or "Tersimpan. Menunggu koneksi."; a refusal is announced by `useFailedOutboxToast`.
   */
  const onSend = () => {
    if (!po) return;
    close();
    submitPo(po.po, mapping)
      .then(async (item) => {
        if (!sender || !navigator.onLine) {
          toast('Tersimpan. Menunggu koneksi.');
          return;
        }
        toast('Sedang dikirim.');
        const after = await sender.send(item.submissionUuid);
        if (after?.state === 'sent' && after.sentAt)
          toast(`PO terkirim ${formatTime(after.sentAt)}`);
        else if (after?.state !== 'failed') toast('Tersimpan. Menunggu koneksi.');
      })
      .catch((error: unknown) => {
        console.error(error);
        toast('PO gagal disimpan. Coba lagi.', 'error');
      });
  };

  const viewed = open?.kind === 'photo' ? session?.photos[open.defectId] : undefined;
  const viewedDefect = viewed ? mapping.defect(viewed.defectId) : undefined;

  const info: Array<[label: string, value: string, mono?: boolean]> = [
    ['PO NUMBER', po?.po ?? '-', true],
    ['ARTIKEL', po?.article ?? '-'],
    ['MODEL', po?.model ?? '-'],
    ['DESTINATION', po?.destination ?? '-'],
    ['FACTORY/CELL', auth.cell],
  ];

  return (
    <main className="app-screen home">
      <header className="home__header">
        <Logo placement="home" />
        <dl className="home__info" aria-label="Info PO">
          {info.map(([label, value, mono]) => (
            <div key={label} className="home__meta">
              <dt>{label}</dt>
              <dd className={mono ? 'home__mono' : undefined}>{value}</dd>
            </div>
          ))}
          {po?.partial ? (
            <div className="home__meta">
              <dt>PARTIAL</dt>
              <dd>{formatPartial(po.partial, po.orderQty)}</dd>
            </div>
          ) : null}
          {po ? (
            <div className="home__meta home__meta--action">
              <Button size="sm" onClick={() => setOpen({ kind: 'partial' })}>
                {po.partial ? 'UBAH PARTIAL' : 'PO PARTIAL'}
              </Button>
            </div>
          ) : null}
        </dl>
        <div className="home__who" aria-label="Akun">
          {!online ? <Chip tone="neutral">Offline</Chip> : null}
          <span className="home__name">{auth.username}</span>
          <Chip tone="role">{auth.level}</Chip>
          <CountBadge value={waiting} label={`${waiting} pengiriman menunggu`} />
        </div>
        <button
          type="button"
          className="home__gear"
          aria-label="Pengaturan"
          aria-haspopup="dialog"
          aria-expanded={open?.kind === 'menu'}
          onClick={() => setOpen({ kind: 'menu' })}
        >
          <Icon name="gear" />
        </button>
      </header>

      <div className="home__body">
        <Pane label="PO LIST" className="home__polist">
          <h2 className="home__pane-title">PO LIST</h2>
          <div className="home__pos">
            {pos.map((p) => (
              <PoRowItem
                key={p.po}
                po={p}
                session={sessions[p.po]}
                selected={p.po === po?.po}
                onSelect={() => void setView({ selectedPo: p.po })}
                onLongPress={() => setOpen({ kind: 'remove', po: p.po })}
              />
            ))}
          </div>
          <Button
            className="home__addpo"
            aria-label="Tambah PO"
            onClick={() => setOpen({ kind: 'add' })}
          >
            <Icon name="plus" />
          </Button>
        </Pane>

        <Pane label="ALL DEFECT" className="home__defects">
          <AllDefect
            po={po}
            session={session}
            mapping={mapping}
            photos={photos}
            onTakePhoto={takePhoto}
            onViewPhoto={(defectId) => setOpen({ kind: 'photo', defectId })}
          />
        </Pane>

        <Pane label="Hasil" className="home__stats">
          <Results
            po={po}
            session={session}
            mode={countingMode(auth.level)}
            onEdit={() => setOpen({ kind: 'qty' })}
            onEditReworkApproved={() => setOpen({ kind: 'rework-approved' })}
          />
        </Pane>

        {active ? (
          <Notice tone="warning" className="home__notice">
            Inspeksi berjalan. Lanjutkan di ADD DEFECT atau selesaikan dengan END INSPECTION.
          </Notice>
        ) : null}

        <Button
          size="lg"
          className="home__add"
          disabled={!po}
          onClick={() => void setView({ screen: 'defect', defectPath: NO_PATH })}
        >
          ADD DEFECT
        </Button>
        <div className="home__exports">
          <Button icon="download" disabled={!sealed} onClick={() => void onExport('pdf')}>
            EXPORT PDF
          </Button>
          <Button icon="download" disabled={!sealed} onClick={() => void onExport('xlsx')}>
            EXPORT EXCEL
          </Button>
        </div>
        <Button
          variant="primary"
          size="lg"
          className="home__submit"
          disabled={!po}
          onClick={onSubmit}
        >
          SUBMIT PO
        </Button>
        <Button
          variant="danger"
          className="home__clear"
          disabled={!po || !hasOpenData(session)}
          onClick={() => setOpen({ kind: 'clear-data' })}
        >
          HAPUS DATA DEFECT
        </Button>
      </div>

      {photos ? (
        <input
          ref={camera}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          data-testid="camera"
          onChange={(event) => void onPhoto(event)}
        />
      ) : null}

      {viewed && viewedDefect && po ? (
        <PhotoViewDialog
          photo={viewed}
          name={viewedDefect.name}
          classification={CHIP_TONE[viewedDefect.classification]}
          onReplace={() => takePhoto(viewed.defectId)}
          onRemove={() => {
            close();
            removePhoto(po.po, viewed.defectId)
              .then(() => toast('Foto dihapus'))
              .catch((error: unknown) => {
                console.error(error);
                toast('Foto gagal dihapus. Coba lagi.', 'error');
              });
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'menu' ? <SettingsDialog auth={auth} onClose={close} /> : null}
      {open?.kind === 'add' ? <AddPoDialog onClose={close} /> : null}
      {open?.kind === 'partial' && po ? <PartialDialog po={po} onClose={close} /> : null}
      {open?.kind === 'missing-photos' ? (
        <MissingPhotosDialog names={open.names} onClose={close} />
      ) : null}
      {open?.kind === 'submit-active' ? (
        <SubmitActiveDialog
          onAddDefect={() => {
            close();
            void setView({ screen: 'defect', defectPath: NO_PATH });
          }}
        />
      ) : null}
      {open?.kind === 'submit-no-pairs' ? (
        <SubmitNoPairsDialog
          onAddDefect={() => {
            close();
            void setView({ screen: 'defect', defectPath: NO_PATH });
          }}
        />
      ) : null}
      {open?.kind === 'submit-empty' ? (
        <SubmitEmptyDialog onClose={() => setOpen({ kind: 'qty' })} />
      ) : null}
      {open?.kind === 'submit-rework-approved' ? (
        <SubmitReworkApprovedDialog onEdit={() => setOpen({ kind: 'rework-approved' })} />
      ) : null}
      {open?.kind === 'rework-approved' && po && session ? (
        <ReworkApprovedDialog po={po} session={session} onClose={close} />
      ) : null}
      {open?.kind === 'qty' && po && session ? (
        <QtyInspectionDialog po={po} session={session} onClose={close} />
      ) : null}
      {open?.kind === 'submit-qty' && po && session ? (
        <QtySubmitDialog
          po={po}
          session={session}
          issue={open.issue}
          onClose={close}
          onEdit={() => setOpen({ kind: 'qty' })}
        />
      ) : null}
      {open?.kind === 'submit-confirm' && po && session ? (
        <SubmitConfirmDialog
          po={po}
          session={session}
          level={auth.level}
          onCancel={close}
          onSend={onSend}
        />
      ) : null}
      {open?.kind === 'remove' ? (
        <Overlay onDismiss={close}>
          <Dialog title="Hapus PO dari list?" onClose={close}>
            <p className="dialog__text home__mono">{open.po}</p>
            <div className="dialog__actions">
              <Button onClick={close}>BATAL</Button>
              <Button
                variant="danger"
                onClick={() => {
                  close();
                  removePo(open.po).catch(console.error);
                }}
              >
                HAPUS
              </Button>
            </div>
          </Dialog>
        </Overlay>
      ) : null}
      {open?.kind === 'clear-data' && po ? (
        <Overlay onDismiss={close}>
          <Dialog title="Hapus data Defect?" onClose={close}>
            <p className="dialog__text">
              Semua data input inspeksi PO {po.po} akan dihapus: data Defect, Rework/Grade B, dan
              QTY INSPECTION kembali kosong. Data yang sudah di-SUBMIT PO tidak terpengaruh.
            </p>
            <div className="dialog__actions">
              <Button onClick={close}>BATAL</Button>
              <Button
                variant="danger"
                onClick={() => {
                  close();
                  clearSessionData(po.po).catch(console.error);
                }}
              >
                HAPUS
              </Button>
            </div>
          </Dialog>
        </Overlay>
      ) : null}
    </main>
  );
}

interface PoRowItemProps {
  po: PoRow;
  session: PoSession | undefined;
  selected: boolean;
  onSelect: () => void;
  onLongPress: () => void;
}

/** A PO in the list (AC-03.2). A long press offers removal only when its open session has no data (AC-03.4). */
function PoRowItem({ po, session, selected, onSelect, onLongPress }: PoRowItemProps) {
  const timer = useRef<number | null>(null);
  const pressed = useRef(false);
  const removable = !hasOpenData(session);
  const active = session?.state.active;

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  return (
    <div
      className="home__po"
      onPointerDown={() => {
        pressed.current = false;
        cancel();
        if (!removable) return;
        timer.current = window.setTimeout(() => {
          timer.current = null;
          pressed.current = true;
          onLongPress();
        }, LONG_PRESS_MS);
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      // The long press is the gesture; the browser's own menu would cover the dialog.
      onContextMenu={(event) => event.preventDefault()}
      onClickCapture={(event) => {
        // The click that ends a long press does not also select the PO.
        if (!pressed.current) return;
        pressed.current = false;
        event.stopPropagation();
      }}
    >
      <POListItem
        po={po.po}
        sub={`${po.model} · ${po.destination}`}
        count={session?.state.recorded.length ?? 0}
        live={active ? `Inspeksi berjalan · ${active.type}` : undefined}
        selected={selected}
        onClick={onSelect}
      />
    </div>
  );
}

const CHIP_TONE = {
  MINOR: 'minor',
  MAJOR: 'major',
  CRITICAL: 'critical',
} as const satisfies Record<Classification, ChipClassification>;

interface PanelProps {
  po: PoRow | null;
  session: PoSession | undefined;
}

interface AllDefectProps extends PanelProps {
  mapping: MappingIndex;
  /** PSI lv.2 (AC-10.6). */
  photos: boolean;
  onTakePhoto: (defectId: DefectId) => void;
  onViewPhoto: (defectId: DefectId) => void;
}

/**
 * ALL DEFECT (FR-05, ADR-022, doc 05 §8.3): every defect of the session, order and ties from `allDefects`
 * (AC-05.1), scrolling inside the pane. For PSI lv.2 each row has its photo control, and a Notice counts the
 * missing photos (AC-10.3, BR-04).
 */
function AllDefect({ po, session, mapping, photos, onTakePhoto, onViewPhoto }: AllDefectProps) {
  const rows = session ? allDefects(findings(session.state), mapping) : [];
  const attached = session?.photos ?? {};
  const missing = photos
    ? missingPhotos(rows, new Set(Object.keys(attached) as DefectId[]), 'ALL').length
    : 0;
  return (
    <>
      <h2 className="home__pane-title">ALL DEFECT</h2>
      {!po ? (
        <Empty title="Belum ada PO" hint="Tekan tombol + di PO List untuk menambahkan PO." />
      ) : rows.length === 0 ? (
        <Empty title="Belum ada defect" hint="Tekan ADD DEFECT untuk mulai input." />
      ) : (
        <div className="home__dlist" role="list">
          {rows.map((row, i) => (
            <div key={row.defectId} role="listitem">
              <DefectItem
                no={i + 1}
                row={row}
                mapping={mapping}
                photos={photos}
                photo={attached[row.defectId]}
                onTakePhoto={() => onTakePhoto(row.defectId)}
                onViewPhoto={() => onViewPhoto(row.defectId)}
              />
            </div>
          ))}
        </div>
      )}
      {missing > 0 ? (
        <Notice tone="warning" title={`${missing} foto belum ada.`} className="home__photo-notice">
          PSI lv.2 wajib melampirkan foto pada setiap defect sebelum SUBMIT PO.
        </Notice>
      ) : null}
    </>
  );
}

interface DefectItemProps {
  no: number;
  row: RankedDefect;
  mapping: MappingIndex;
  photos: boolean;
  photo: PhotoRow | undefined;
  onTakePhoto: () => void;
  onViewPhoto: () => void;
}

function DefectItem({
  no,
  row,
  mapping,
  photos,
  photo,
  onTakePhoto,
  onViewPhoto,
}: DefectItemProps) {
  const src = usePhotoUrl(photo?.blob);
  const name = mapping.defect(row.defectId)?.name ?? row.defectId;
  return (
    <Top5Row
      no={no}
      name={name}
      classification={CHIP_TONE[row.classification]}
      areas={areaLabels(row.areaIds, mapping)}
      qty={row.qty}
      photo={
        !photos
          ? undefined
          : photo
            ? { state: 'attached', src, label: `Lihat foto ${name}`, onClick: onViewPhoto }
            : { state: 'required', onClick: onTakePhoto }
      }
      flag={photos && !photo ? 'Foto wajib' : undefined}
    />
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="home__empty">
      <b>{title}</b>
      <span>{hint}</span>
    </div>
  );
}

/**
 * The results box (FR-04, doc 05 §8.1): nine values, using zero fallbacks until Qty Inspection is valid. PSI lv.1
 * taps QTY INSPECTION to enter it; PSI lv.2 sees it counted from NO DEFECT and END INSPECTION (ADR-021). Both
 * levels see INSPECTION REWORK QTY (read-only) and tap REWORK AND APPROVED (S5c) while there is rework, or while
 * its saved value is not valid, so it can be corrected (FR-16, BR-11). Neither adds a term to the rates.
 */
function Results({
  po,
  session,
  mode,
  onEdit,
  onEditReworkApproved,
}: PanelProps & { mode: CountingMode; onEdit: () => void; onEditReworkApproved: () => void }) {
  if (!po) {
    return (
      <div className="home__results home__results--off">
        <StatRow label="Qty PO Order" value={null} />
        <StatRow label="Qty Inspection" value={null} />
        <StatRow label="Qty Defect" value="0" />
        <StatRow label="Qty A-Grade" value="0" />
        <StatRow label="Qty B-Grade" value="0" />
        <StatRow label="INSPECTION REWORK QTY" value="0" />
        <StatRow label="REWORK AND APPROVED" value={null} />
        <StatRow label="Defect Rate" value={null} />
        <StatRow label="Pass Rate (RFT)" value={null} />
      </div>
    );
  }
  const t = totals(session?.state ?? emptySession(mode), po);
  const entered = mode === 'ENTERED';
  const bad = t.defectRate !== null && t.defectRate > DEFECT_RATE_BAD_ABOVE;
  // Disabled at 0 rework unless the saved value is not valid (ADR-022 decision 6 as amended).
  const approvable = t.inspectionReworkQty > 0 || t.reworkApprovedIssue !== null;
  return (
    <div className="home__results">
      <StatRow label="Qty PO Order" value={formatCount(po.orderQty)} />
      <StatRow
        label="Qty Inspection"
        value={t.qtyInspection === null ? null : formatCount(t.qtyInspection)}
        tone={t.qtyInspection !== null && t.qtyInspectionIssue ? 'bad' : undefined}
        onClick={entered ? onEdit : undefined}
      />
      {entered && t.qtyInspection === null ? <span>Ketuk untuk isi</span> : null}
      <StatRow label="Qty Defect" value={formatCount(t.qtyDefect)} />
      <StatRow label="Qty A-Grade" value={formatCount(t.qtyAGrade ?? 0)} />
      <StatRow label="Qty B-Grade" value={formatCount(t.qtyBGrade)} />
      <StatRow label="INSPECTION REWORK QTY" value={formatCount(t.inspectionReworkQty)} />
      <StatRow
        label="REWORK AND APPROVED"
        // An entered value stays visible when it is not valid; it is never clamped after UNDO (BR-11).
        value={t.reworkApproved === null ? null : formatCount(t.reworkApproved)}
        tone={t.reworkApprovedIssue ? 'bad' : undefined}
        className={approvable ? undefined : 'home__stat--off'}
        onClick={approvable ? onEditReworkApproved : undefined}
      />
      {!approvable ? (
        <span>Belum ada inspeksi REWORK.</span>
      ) : t.reworkApproved === null ? (
        <span>Ketuk untuk isi</span>
      ) : null}
      <StatRow
        label="Defect Rate"
        value={formatRate(t.defectRate ?? 0)}
        tone={bad ? 'bad' : undefined}
      />
      <StatRow label="Pass Rate (RFT)" value={formatRate(t.passRate ?? 0)} />
      {t.qtyInspectionIssue ? (
        <Notice tone="warning">
          {qtyNotice(t.qtyInspectionIssue.kind, t.qtyDefect, po, mode)}
        </Notice>
      ) : null}
      {t.reworkApprovedIssue ? (
        <Notice tone="warning">
          REWORK AND APPROVED melebihi INSPECTION REWORK QTY. Ubah angkanya sebelum SUBMIT PO.
        </Notice>
      ) : null}
    </div>
  );
}
