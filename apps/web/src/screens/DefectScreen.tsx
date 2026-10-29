/**
 * S6 Defect screen (doc 05 §11): REWORK / B-GRADE (and NO DEFECT for PSI lv.2, ADR-021) above the shoe map and
 * END INSPECTION below it; on
 * the right the context line, breadcrumb, drill-down list, the session's history and BACK / HOME / UNDO.
 *
 * Every tap goes through `store.tap`, which writes to IndexedDB before the state changes (NFR-05); counting comes
 * from `@m100/shared` (BR-01). A defect row flashes in the frame of the tap (AC-07.2, NFR-03); counts, history and
 * the toast follow once the tap is stored.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  canAddPair,
  countingMode,
  emptySession,
  findings,
  formatCount,
  type AreaId,
  type AreaMapEntry,
  type Classification,
  type InspectionType,
  type RecordedDefect,
} from '@m100/shared';
import { useBackGesture } from '../app/useBackGesture';
import { useMapping } from '../app/mapping';
import { useToast } from '../app/toastContext';
import type { DefectPath, PoRow } from '../db/schema';
import { useAppStore, type TapCommand, type TapResult } from '../state/store';
import {
  BottomBar,
  Breadcrumb,
  Chip,
  CommandButton,
  HistoryRow,
  List,
  Notice,
  OptionRow,
  Pane,
  SHOE_AREAS,
  SHOE_AREAS_COMPACT,
  ShoeMap,
  minMapHeight,
  type Classification as ChipClassification,
  type CommandButtonProps,
  type ShoeMapArea,
  type ShoeMapAreaState,
} from '../ui';
import {
  NO_PATH,
  areaCounts,
  countWhere,
  crumbs,
  defectCountOf,
  historyKey,
  historyPath,
  levelOf,
  selectFamily,
  selectSubArea,
  selectArea,
  up,
} from './drilldown';
import './screens.css';

/** The shoe photo in `public/` (design-system Shoe map image), precached with the app. */
export const SHOE_SRC = '/erasebg-transformed.avif';

const CHIP_TONE = {
  MINOR: 'minor',
  MAJOR: 'major',
  CRITICAL: 'critical',
} as const satisfies Record<Classification, ChipClassification>;

const TYPE_TONE = { REWORK: 'rework', 'B-GRADE': 'bgrade' } as const satisfies Record<
  InspectionType,
  ChipClassification | 'rework' | 'bgrade'
>;

/** Doc 05 G9. */
function vibrate(): void {
  try {
    if ('vibrate' in navigator) navigator.vibrate(18);
  } catch {
    // Not supported: silent.
  }
}

/** Below this map height the design-system docks would overlap or stick out, so the compact docks are used (U13). */
const REGULAR_MIN_HEIGHT = minMapHeight(SHOE_AREAS);

/**
 * The pill layout that fits the map as rendered (doc 05 U13). The map's size never depends on the layout, so the
 * choice can't flip back and forth. Without `ResizeObserver` the design-system docks stay.
 */
function useShoeLayout(container: RefObject<HTMLElement | null>): ShoeMapArea[] {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const map = container.current?.firstElementChild;
    if (!map || typeof ResizeObserver === 'undefined') return;
    const update = () => setCompact(map.getBoundingClientRect().height < REGULAR_MIN_HEIGHT);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(map);
    return () => observer.disconnect();
  }, [container]);
  return compact ? SHOE_AREAS_COMPACT : SHOE_AREAS;
}

/** A flash to play once; `n` makes React mount the row again so the animation restarts on every tap. */
interface Flash {
  key: string;
  n: number;
}

export interface DefectScreenProps {
  po: PoRow;
}

export function DefectScreen({ po }: DefectScreenProps) {
  const mapping = useMapping();
  const toast = useToast();
  const session = useAppStore((s) => s.sessions[po.po]);
  const path = useAppStore((s) => s.view.defectPath);
  const tap = useAppStore((s) => s.tap);
  const setView = useAppStore((s) => s.setView);
  const level = useAppStore((s) => s.auth?.level ?? 'PSI lv.1');
  const [optionFlash, setOptionFlash] = useState<Flash | null>(null);
  const [historyFlash, setHistoryFlash] = useState<Flash | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const layout = useShoeLayout(mapRef);

  const state = session?.state ?? emptySession(countingMode(level));
  const active = state.active;
  const defects = active?.defects ?? [];
  const history = findings(state);

  const go = (defectPath: DefectPath) => {
    // A flash belongs to the list it was tapped in; it must not replay when that list is opened again.
    setOptionFlash(null);
    setView({ defectPath }).catch(console.error);
  };
  const home = () => {
    setView({ screen: 'home', defectPath: NO_PATH }).catch(console.error);
  };
  const back = () => {
    const next = up(mapping, path);
    if (next) go(next);
    else home();
  };
  useBackGesture(back);

  /** Runs a tap; `then` gets what it did. A refused tap does nothing (the button state already says why). */
  const run = (command: TapCommand, then: (result: TapResult) => void) => {
    tap(po.po, command)
      .then((result) => {
        if (result) then(result);
      })
      .catch(console.error);
  };

  const flashHistory = (key: string) => setHistoryFlash((f) => ({ key, n: (f?.n ?? 0) + 1 }));

  // AC-09.1: the row just changed is scrolled into view.
  useEffect(() => {
    if (!historyFlash) return;
    const row = Array.from(historyRef.current?.children ?? []).find(
      (el) => el instanceof HTMLElement && el.dataset.key === historyFlash.key,
    );
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [historyFlash]);

  const start = (inspection: InspectionType) =>
    run({ type: 'START', inspection }, () => {
      go(NO_PATH);
      toast(`Inspeksi ${inspection} dimulai`);
    });

  // PSI lv.2 only (ADR-021): one A-Grade pair at once, no END INSPECTION.
  const noDefect = () =>
    run({ type: 'NO_DEFECT' }, () => {
      go(NO_PATH);
      toast('No Defect tercatat. A-Grade +1');
    });

  const end = () =>
    run({ type: 'END' }, ({ before }) => {
      go(NO_PATH);
      const n = before.active?.defects.length ?? 0;
      toast(n > 0 ? `Inspeksi selesai. ${n} defect tercatat` : 'Inspeksi selesai tanpa defect');
    });

  const undo = () =>
    run({ type: 'UNDO' }, ({ before, after }) => {
      vibrate();
      if (before.undo === 'DEFECT') {
        const last = before.active?.defects.at(-1);
        if (last && findings(after).some((f) => historyKey(f) === historyKey(last))) {
          flashHistory(historyKey(last));
        }
        toast('Defect terakhir dibatalkan');
      } else if (before.undo === 'INSPECTION') {
        go(NO_PATH);
        toast('Inspeksi dibatalkan');
      } else {
        toast('No Defect dibatalkan');
      }
    });

  const record = (entry: AreaMapEntry) => {
    setOptionFlash((f) => ({ key: entry.defectId, n: (f?.n ?? 0) + 1 }));
    run({ type: 'DEFECT', entry }, ({ before }) => {
      vibrate();
      const type = before.active?.type ?? 'REWORK';
      flashHistory(historyKey({ ...entry, inspectionType: type }));
      toast(type === 'B-GRADE' ? '+1 Defect dan B-Grade' : '+1 Defect');
    });
  };

  // PSI lv.2 counts pairs with taps, up to the partial quantity or Qty Order (ADR-021).
  const tapped = state.mode === 'TAPPED';
  const room = canAddPair(state, po);
  const commandState = (type: InspectionType): CommandButtonProps['state'] =>
    !active ? (room ? 'idle' : 'disabled') : active.type === type ? 'active' : 'disabled';

  const counts = areaCounts(defects);
  const areas: Record<string, ShoeMapAreaState> = {};
  for (const a of SHOE_AREAS) {
    areas[a.id] = {
      selected: !!active && a.id === path.areaId,
      count: counts[a.id as AreaId],
    };
  }

  return (
    <main className="app-screen defect">
      <Pane label="Sepatu" className="defect__shoe">
        <div className={tapped ? 'defect__cmds defect__cmds--three' : 'defect__cmds'}>
          <CommandButton
            mode="rework"
            state={commandState('REWORK')}
            onClick={() => start('REWORK')}
          />
          <CommandButton
            mode="bgrade"
            state={commandState('B-GRADE')}
            onClick={() => start('B-GRADE')}
          />
          {tapped ? (
            <CommandButton
              mode="nodefect"
              state={active || !room ? 'disabled' : 'idle'}
              onClick={noDefect}
            />
          ) : null}
        </div>
        {tapped && !active && !room ? (
          <Notice tone="warning">
            Qty Inspection sudah {formatCount(po.partial?.qty ?? po.orderQty)} pasang, maksimum PO
            ini. Tidak bisa menambah pasang lagi.
          </Notice>
        ) : null}
        <div className="defect__map" ref={mapRef}>
          <ShoeMap
            src={SHOE_SRC}
            layout={layout}
            areas={areas}
            disabled={!active}
            onSelect={(id) => go(selectArea(mapping, id as AreaId))}
          />
        </div>
        <CommandButton
          mode="end"
          state={active ? 'idle' : 'disabled'}
          className="defect__end"
          onClick={end}
        />
      </Pane>

      <section className="defect__side" aria-label="Input defect">
        <div className="defect__ctx">
          <p className="defect__po">
            {active ? <Chip tone={TYPE_TONE[active.type]} /> : null}
            <span>
              <span className="defect__mono">PO {po.po}</span> · {po.article} · {po.model}
            </span>
          </p>
          {active && path.areaId ? (
            <Breadcrumb
              items={crumbs(mapping, path).map((c) => ({
                label: c.label,
                onClick: () => go(c.path),
              }))}
            />
          ) : null}
        </div>

        <DrillDown
          // A new level starts at the top; the same level keeps its scroll position (FR-07.3).
          key={`${path.areaId}|${path.subAreaId}|${path.familyId}|${!!active}`}
          active={!!active}
          tapped={tapped}
          path={path}
          defects={defects}
          flash={optionFlash}
          onPath={go}
          onDefect={record}
        />

        <section className="defect__hist" aria-label="Riwayat defect">
          <HistoryRow head />
          <div className="defect__hist-body" role="list" ref={historyRef}>
            {history.length === 0 ? (
              <p className="defect__hist-empty">Belum ada defect tercatat untuk PO ini.</p>
            ) : (
              history.map((f, i) => {
                const key = historyKey(f);
                const flashing = historyFlash?.key === key;
                const defect = mapping.defect(f.defectId);
                return (
                  <div
                    key={flashing ? `${key}#${historyFlash.n}` : key}
                    role="listitem"
                    data-key={key}
                  >
                    <HistoryRow
                      no={i + 1}
                      name={defect?.name ?? f.defectId}
                      path={historyPath(mapping, f)}
                      classification={defect ? CHIP_TONE[defect.classification] : undefined}
                      qty={f.qty}
                      flash={flashing}
                    />
                  </div>
                );
              })
            )}
          </div>
        </section>

        <BottomBar
          label="Navigasi input defect"
          className="defect__bar"
          items={[
            { label: 'BACK', icon: 'back', onClick: back },
            { label: 'HOME', icon: 'home', onClick: home },
            { label: 'UNDO', icon: 'undo', onClick: undo, disabled: !state.undo },
          ]}
        />
      </section>
    </main>
  );
}

interface DrillDownProps {
  active: boolean;
  /** PSI lv.2 counts pairs with NO DEFECT (ADR-021); PSI lv.1 enters Qty Inspection on Home. */
  tapped: boolean;
  path: DefectPath;
  defects: readonly RecordedDefect[];
  flash: Flash | null;
  onPath: (path: DefectPath) => void;
  onDefect: (entry: AreaMapEntry) => void;
}

/** The drill-down list (doc 05 §11.3), or the hint of the level it can't show yet. */
function DrillDown({ active, tapped, path, defects, flash, onPath, onDefect }: DrillDownProps) {
  const mapping = useMapping();
  const { areaId, subAreaId, familyId } = path;
  const level = active ? levelOf(path) : 0;

  let content;
  if (!active) {
    content = (
      <Hint
        title="Mulai inspeksi"
        text={
          tapped
            ? 'Pilih REWORK atau B-GRADE untuk mengaktifkan area dan defect, atau NO DEFECT untuk pasang tanpa defect.'
            : 'Pilih REWORK atau B-GRADE untuk mengaktifkan area dan defect. Pasang tanpa defect tidak perlu ditekan; isi QTY INSPECTION di Home.'
        }
      />
    );
  } else if (level === 0 || !areaId) {
    content = (
      <Hint
        title="Pilih area sepatu"
        text="Sentuh salah satu area pada gambar sepatu. Defect yang tercatat ditandai angka biru."
      />
    );
  } else if (level === 1 || !subAreaId) {
    content = (
      <List>
        {mapping.subAreasOf(areaId).map((s) => (
          <OptionRow
            key={s.id}
            kind="nav"
            title={s.name}
            sub={`${defectCountOf(mapping, s.id)} defect`}
            count={countWhere(defects, { subAreaId: s.id }) || undefined}
            onClick={() => onPath(selectSubArea(mapping, areaId, s.id))}
          />
        ))}
      </List>
    );
  } else if (level === 2 || !familyId) {
    content = (
      <List>
        {mapping.familiesOf(subAreaId).map((f) => (
          <OptionRow
            key={f.id}
            kind="nav"
            title={f.name}
            sub={`${mapping.defectsOf(subAreaId, f.id).length} defect`}
            count={countWhere(defects, { subAreaId, familyId: f.id }) || undefined}
            onClick={() => onPath(selectFamily(path, f.id))}
          />
        ))}
      </List>
    );
  } else {
    content = (
      <List>
        {mapping.defectsOf(subAreaId, familyId).map((d) => {
          const flashing = flash?.key === d.id;
          return (
            <OptionRow
              key={flashing ? `${d.id}#${flash.n}` : d.id}
              kind="defect"
              title={d.name}
              classification={CHIP_TONE[d.classification]}
              qty={countWhere(defects, { subAreaId, defectId: d.id })}
              flash={flashing}
              onClick={() => onDefect({ areaId, subAreaId, familyId, defectId: d.id })}
            />
          );
        })}
      </List>
    );
  }

  return (
    <div className="defect__pick" aria-label="Pilihan" role="region">
      {content}
    </div>
  );
}

function Hint({ title, text }: { title: string; text: string }) {
  return (
    <div className="defect__hint">
      <b>{title}</b>
      <span>{text}</span>
    </div>
  );
}
