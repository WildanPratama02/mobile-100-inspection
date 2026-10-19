import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { defaultMapping, totals, type Po } from '@m100/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToastProvider } from '../app/toast';
import { ALL_PO_MASTER } from '../data/fixtures/pos';
import { createDb, type Auth, type M100Db } from '../db/schema';
import { AppStoreContext, createAppStore, type AppStore } from '../state/store';
import { DefectScreen } from './DefectScreen';
import { NO_PATH, selectSubArea } from './drilldown';

const AUTH: Auth = {
  username: 'DEWI CONTOH',
  level: 'PSI lv.2',
  factory: 'F 3',
  cell: 'F3-10',
  token: null,
  tokenExpiresAt: null,
};
const PO: Po = ALL_PO_MASTER.find((p) => p.po === '0903359388')!;

const mapping = defaultMapping();
// Quarter › Medial Quarter › its first family, and the first two defects there.
const FAMILY = mapping.familiesOf('SA03M')[0]!;
const [D1, D2] = mapping.defectsOf('SA03M', FAMILY.id);

let db: M100Db;
let store: AppStore;

beforeEach(async () => {
  db = createDb(`defect-${crypto.randomUUID()}`);
  store = createAppStore(db);
  await store.getState().hydrate();
  await store.getState().login(AUTH);
  await store.getState().addPo(PO, null);
  await store.getState().setView({ screen: 'defect' });
});

afterEach(async () => {
  await db.delete();
});

function renderDefect() {
  const po = store.getState().pos[0]!;
  render(
    <AppStoreContext.Provider value={store}>
      <ToastProvider>
        <DefectScreen po={po} />
      </ToastProvider>
    </AppStoreContext.Provider>,
  );
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const pill = (name: string) =>
  within(screen.getByRole('group', { name: 'Pilih area sepatu' })).getByRole('button', { name });
const bar = (name: string) =>
  within(screen.getByRole('navigation', { name: 'Navigasi input defect' })).getByRole('button', {
    name,
  });
const pick = () => screen.getByRole('region', { name: 'Pilihan' });
const option = (title: string) =>
  within(pick()).getByRole('button', { name: new RegExp(`^${escape(title)}`) });
const historyRows = () =>
  within(screen.getByRole('region', { name: 'Riwayat defect' })).queryAllByRole('listitem');
const session = () => store.getState().sessions[PO.po]!.state;

async function toast(text: string) {
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(text));
}

async function startRework() {
  fireEvent.click(button('REWORK'));
  await toast('Inspeksi REWORK dimulai');
}

/** Quarter › Medial Quarter › FAMILY. */
async function openFamily() {
  fireEvent.click(pill('QUARTER'));
  fireEvent.click(await waitFor(() => option('Medial Quarter')));
  fireEvent.click(await waitFor(() => option(FAMILY.name)));
  await waitFor(() => option(D1!.name));
}

describe('command states (doc 05 §11.2)', () => {
  it('with no active inspection, disables areas, END and UNDO and says how to start', () => {
    renderDefect();
    expect(button('REWORK')).toBeEnabled();
    expect(button('B-GRADE')).toBeEnabled();
    expect(button('NO DEFECT')).toBeEnabled();
    expect(button('END INSPECTION')).toBeDisabled();
    expect(bar('UNDO')).toBeDisabled();
    expect(pill('QUARTER')).toBeDisabled();
    expect(pill('GENERAL')).toBeDisabled();
    expect(screen.getByText('Mulai inspeksi')).toBeVisible();
    expect(screen.getByText('Belum ada defect tercatat untuk PO ini.')).toBeVisible();
  });

  it('REWORK highlights itself, disables the other starts and enables areas and END', async () => {
    renderDefect();
    await startRework();
    expect(button('REWORK')).toHaveAttribute('aria-pressed', 'true');
    expect(button('B-GRADE')).toBeDisabled();
    expect(button('NO DEFECT')).toBeDisabled();
    expect(button('END INSPECTION')).toBeEnabled();
    expect(pill('QUARTER')).toBeEnabled();
    expect(screen.getByText('Pilih area sepatu')).toBeVisible();
    expect(screen.getByText(/PO 0903359388/).closest('p')).toHaveTextContent('REWORK');
  });

  it('B-GRADE starts a B-GRADE inspection', async () => {
    renderDefect();
    fireEvent.click(button('B-GRADE'));
    await toast('Inspeksi B-GRADE dimulai');
    expect(button('B-GRADE')).toHaveAttribute('aria-pressed', 'true');
    expect(button('REWORK')).toBeDisabled();
    expect(session().active?.type).toBe('B-GRADE');
  });

  it('NO DEFECT records an A-Grade pair at once and stays idle (U1)', async () => {
    renderDefect();
    fireEvent.click(button('NO DEFECT'));
    await toast('No Defect tercatat. A-Grade +1');
    expect(totals(session())).toMatchObject({ qtyInspection: 1, qtyAGrade: 1 });
    expect(button('REWORK')).toBeEnabled();
    expect(button('END INSPECTION')).toBeDisabled();
    expect(pill('QUARTER')).toBeDisabled();
  });

  it('END INSPECTION without defects counts one inspection (AC-06.3)', async () => {
    renderDefect();
    await startRework();
    fireEvent.click(button('END INSPECTION'));
    await toast('Inspeksi selesai tanpa defect');
    expect(totals(session())).toMatchObject({ qtyInspection: 1, qtyDefect: 0 });
    expect(button('END INSPECTION')).toBeDisabled();
    expect(screen.getByText('Mulai inspeksi')).toBeVisible();
  });
});

describe('recording defects (FR-07, FR-09)', () => {
  it('records a tap, shows its count on the row, the pill and the history', async () => {
    renderDefect();
    await startRework();
    await openFamily();
    fireEvent.click(option(D1!.name));
    await toast('+1 Defect');
    fireEvent.click(option(D1!.name));
    await waitFor(() => expect(session().active?.defects).toHaveLength(2));

    expect(option(D1!.name)).toHaveTextContent(/2$/);
    expect(option(D1!.name)).toHaveTextContent(D1!.classification);
    expect(within(pill('QUARTER')).getByText('2')).toBeVisible();
    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent(D1!.name);
    expect(rows[0]).toHaveTextContent(`Quarter › Medial Quarter · ${FAMILY.name} · REWORK`);
    expect(rows[0]).toHaveTextContent(/2$/);
    expect(screen.getByRole('navigation', { name: 'Posisi' })).toHaveTextContent(
      `Quarter›Medial Quarter›${FAMILY.name}`,
    );
  });

  it('keeps one history row per type + area + sub-area + defect (AC-09.2)', async () => {
    renderDefect();
    await startRework();
    await openFamily();
    fireEvent.click(option(D1!.name));
    await toast('+1 Defect');
    fireEvent.click(button('END INSPECTION'));
    await toast('Inspeksi selesai. 1 defect tercatat');

    fireEvent.click(button('B-GRADE'));
    await toast('Inspeksi B-GRADE dimulai');
    await openFamily();
    fireEvent.click(option(D1!.name));
    await toast('+1 Defect dan B-Grade');
    fireEvent.click(option(D2!.name));
    await waitFor(() => expect(historyRows()).toHaveLength(3));

    expect(historyRows()[1]).toHaveTextContent('B-GRADE');
    // The row count is of the active inspection only (AC-07.3): the REWORK tap does not show.
    expect(option(D1!.name)).toHaveTextContent(/1$/);
    expect(totals(session())).toMatchObject({ qtyInspection: 2, qtyDefect: 3, qtyBGrade: 2 });
  });

  it('opens an area with one sub-area at its families', async () => {
    renderDefect();
    await startRework();
    fireEvent.click(pill('TOE BOX'));
    const family = mapping.familiesOf('SA01')[0]!;
    await waitFor(() => option(family.name));
    expect(screen.getByRole('navigation', { name: 'Posisi' })).toHaveTextContent(/^Toe Box$/);
  });
});

describe('BACK, HOME, UNDO (FR-08)', () => {
  it('UNDO removes the last defect, then cancels the inspection, then is disabled (AC-08.1)', async () => {
    renderDefect();
    await startRework();
    await openFamily();
    fireEvent.click(option(D1!.name));
    await toast('+1 Defect');

    fireEvent.click(bar('UNDO'));
    await toast('Defect terakhir dibatalkan');
    expect(historyRows()).toHaveLength(0);
    expect(session().active?.defects).toHaveLength(0);

    fireEvent.click(bar('UNDO'));
    await toast('Inspeksi dibatalkan');
    expect(totals(session()).qtyInspection).toBe(0);
    expect(bar('UNDO')).toBeDisabled();
    await waitFor(() => expect(store.getState().view.defectPath).toEqual(NO_PATH));
  });

  it('UNDO right after NO DEFECT cancels it', async () => {
    renderDefect();
    fireEvent.click(button('NO DEFECT'));
    await toast('No Defect tercatat');
    fireEvent.click(bar('UNDO'));
    await toast('No Defect dibatalkan');
    expect(totals(session())).toMatchObject({ qtyInspection: 0, qtyAGrade: 0 });
    expect(bar('UNDO')).toBeDisabled();
  });

  it('UNDO never reaches an ended inspection', async () => {
    renderDefect();
    await startRework();
    fireEvent.click(button('END INSPECTION'));
    await toast('Inspeksi selesai');
    expect(bar('UNDO')).toBeDisabled();
  });

  it('BACK goes up one level, a crumb goes to its level, and BACK at the top returns Home', async () => {
    renderDefect();
    await startRework();
    await openFamily();

    fireEvent.click(button('Quarter'));
    await waitFor(() => option('Medial Quarter'));
    expect(store.getState().view.defectPath).toEqual({
      areaId: 'A03',
      subAreaId: null,
      familyId: null,
    });

    fireEvent.click(option('Medial Quarter'));
    await waitFor(() => option(FAMILY.name));
    fireEvent.click(bar('BACK'));
    await waitFor(() => option('Lateral Quarter'));
    fireEvent.click(bar('BACK'));
    await waitFor(() => screen.getByText('Pilih area sepatu'));
    fireEvent.click(bar('BACK'));
    await waitFor(() => expect(store.getState().view.screen).toBe('home'));
  });

  it('BACK skips a level that had one option (BR-08)', async () => {
    await store.getState().tap(PO.po, { type: 'START', inspection: 'REWORK' });
    await store.getState().setView({ defectPath: selectSubArea(mapping, 'A04', 'SA04C') });
    renderDefect();
    fireEvent.click(bar('BACK'));
    await waitFor(() => option('Heel Quarter'));
  });

  it('HOME returns Home and keeps the inspection active (AC-06.2)', async () => {
    renderDefect();
    await startRework();
    fireEvent.click(bar('HOME'));
    await waitFor(() => expect(store.getState().view.screen).toBe('home'));
    expect(session().active?.type).toBe('REWORK');
  });
});
