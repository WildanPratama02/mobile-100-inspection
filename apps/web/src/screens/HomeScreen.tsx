/**
 * S3 Home (doc 05 §8): the PO info strip and account in the header, the PO list, TOP 5 DEFECT, the results box
 * and the bottom row. Everything shown is derived from the selected PO's open session with `@m100/shared`
 * (FR-04, FR-05); nothing here counts by itself.
 *
 * Wired later: the Top 5 photo control (T1.5), EXPORT PDF / EXCEL (T1.6), SUBMIT PO (T1.7).
 */
import { useRef, useState } from 'react';
import {
  EMPTY_SESSION,
  formatCount,
  formatPartial,
  formatRate,
  top5,
  totals,
  type AreaId,
  type Classification,
  type MappingIndex,
} from '@m100/shared';
import { Logo } from '../app/Logo';
import { useMapping } from '../app/mapping';
import { Overlay } from '../app/Overlay';
import { useOnline } from '../app/useOnline';
import type { Auth, PoRow } from '../db/schema';
import { hasOpenData, selectedPo, useAppStore, type PoSession } from '../state/store';
import {
  Button,
  Chip,
  Dialog,
  Icon,
  Notice,
  Pane,
  POListItem,
  SHOE_AREAS,
  StatRow,
  Top5Row,
  type Classification as ChipClassification,
} from '../ui';
import { AddPoDialog } from './AddPoDialog';
import { NO_PATH } from './drilldown';
import { PartialDialog } from './PartialDialog';
import { SettingsDialog } from './SettingsDialog';
import './screens.css';

/** U3: Defect Rate shows `bad` above this. A display aid only, not a business rule; change it here. */
export const DEFECT_RATE_BAD_ABOVE = 0.05;

/** Doc 05 §8.4: a long press this long on a PO without data offers to remove it (AC-03.4). */
export const LONG_PRESS_MS = 600;

/** One dialog at a time (doc 05 §2). */
type Open =
  { kind: 'menu' } | { kind: 'add' } | { kind: 'partial' } | { kind: 'remove'; po: string };

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
  const [open, setOpen] = useState<Open | null>(null);
  const close = () => setOpen(null);

  const session = po ? sessions[po.po] : undefined;
  const active = session?.state.active ?? null;

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

        <Pane label="TOP 5 DEFECT" className="home__top5">
          <Top5 po={po} session={session} mapping={mapping} />
        </Pane>

        <Pane label="Hasil" className="home__stats">
          <Results po={po} session={session} />
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
          <Button icon="download" disabled={!po}>
            EXPORT PDF
          </Button>
          <Button icon="download" disabled={!po}>
            EXPORT EXCEL
          </Button>
        </div>
        <Button variant="primary" size="lg" className="home__submit" disabled={!po}>
          SUBMIT PO
        </Button>
      </div>

      {open?.kind === 'menu' ? <SettingsDialog auth={auth} onClose={close} /> : null}
      {open?.kind === 'add' ? <AddPoDialog onClose={close} /> : null}
      {open?.kind === 'partial' && po ? <PartialDialog po={po} onClose={close} /> : null}
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

/** Area names as on the shoe map pills ("VAMP, TOE BOX"; doc 05 §8.3). */
const AREA_LABEL = new Map(SHOE_AREAS.map((a) => [a.id, a.lines.join(' ')]));

function areaLabels(ids: readonly AreaId[], mapping: MappingIndex): string {
  return ids.map((id) => AREA_LABEL.get(id) ?? mapping.area(id)?.name ?? id).join(', ');
}

interface PanelProps {
  po: PoRow | null;
  session: PoSession | undefined;
}

/** TOP 5 DEFECT (FR-05, doc 05 §8.3): order and ties come from `top5` (AC-05.1). */
function Top5({ po, session, mapping }: PanelProps & { mapping: MappingIndex }) {
  const rows = session ? top5(session.state, mapping) : [];
  return (
    <>
      <h2 className="home__pane-title">TOP 5 DEFECT</h2>
      {!po ? (
        <Empty title="Belum ada PO" hint="Tekan tombol + di PO List untuk menambahkan PO." />
      ) : rows.length === 0 ? (
        <Empty title="Belum ada defect" hint="Tekan ADD DEFECT untuk mulai input." />
      ) : (
        <div className="home__t5" role="list">
          {rows.map((row, i) => (
            <div key={row.defectId} role="listitem">
              <Top5Row
                no={i + 1}
                name={mapping.defect(row.defectId)?.name ?? row.defectId}
                classification={CHIP_TONE[row.classification]}
                areas={areaLabels(row.areaIds, mapping)}
                qty={row.qty}
              />
            </div>
          ))}
        </div>
      )}
    </>
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

/** The results box (FR-04): seven values of the open session, "—" for a rate when Qty Inspection is 0. */
function Results({ po, session }: PanelProps) {
  if (!po) {
    return (
      <div className="home__results home__results--off">
        <StatRow label="Qty PO Order" value={null} />
        <StatRow label="Qty Inspection" value="0" />
        <StatRow label="Qty Defect" value="0" />
        <StatRow label="Qty A-Grade" value="0" />
        <StatRow label="Qty B-Grade" value="0" />
        <StatRow label="Defect Rate" value={null} />
        <StatRow label="Pass Rate (RFT)" value={null} />
      </div>
    );
  }
  const t = totals(session?.state ?? EMPTY_SESSION);
  const bad = t.defectRate !== null && t.defectRate > DEFECT_RATE_BAD_ABOVE;
  return (
    <div className="home__results">
      <StatRow label="Qty PO Order" value={formatCount(po.orderQty)} />
      <StatRow label="Qty Inspection" value={formatCount(t.qtyInspection)} />
      <StatRow label="Qty Defect" value={formatCount(t.qtyDefect)} />
      <StatRow label="Qty A-Grade" value={formatCount(t.qtyAGrade)} />
      <StatRow label="Qty B-Grade" value={formatCount(t.qtyBGrade)} />
      <StatRow
        label="Defect Rate"
        value={t.defectRate === null ? null : formatRate(t.defectRate)}
        tone={bad ? 'bad' : undefined}
      />
      <StatRow
        label="Pass Rate (RFT)"
        value={t.passRate === null ? null : formatRate(t.passRate)}
      />
    </div>
  );
}
