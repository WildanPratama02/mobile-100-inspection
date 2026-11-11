import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { defaultMapping, findings, totals, type Po } from '@m100/shared';
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
const LV1: Auth = { ...AUTH, username: 'ANDI CONTOH', level: 'PSI lv.1' };
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

/** The same PO and screen for a PSI lv.1, who enters Qty Inspection on Home (ADR-019). */
async function asLv1() {
  await store.getState().logout();
  await store.getState().login(LV1);
  await store.getState().addPo(PO, null);
  await store.getState().setView({ screen: 'defect' });
}

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
/** The NO DEFECT history row of PSI lv.2, a button since ADR-023. */
const noDefectRow = () => screen.getByRole('button', { name: 'Ubah NO DEFECT' });
const END_HINT = 'Catat minimal 1 defect sebelum END INSPECTION.';
const EMPTY_HISTORY = 'Belum ada defect tercatat untuk inspeksi ini.';
const session = () => store.getState().sessions[PO.po]!.state;

/** The toast; a Notice (also a status) may be shown next to it. */
async function toast(text: string) {
  await waitFor(() =>
    expect(screen.getAllByRole('status').map((el) => el.textContent ?? '')).toContainEqual(
      expect.stringContaining(text),
    ),
  );
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
    expect(screen.getByText(/atau NO DEFECT untuk pasang tanpa defect\.$/)).toBeVisible();
    // PSI lv.2: the NO DEFECT row is shown at 0 (ADR-023); the old empty text is gone.
    expect(noDefectRow()).toHaveTextContent('NO DEFECT');
    expect(noDefectRow().querySelector('.m100-hist__q')).toHaveTextContent('0');
    expect(screen.queryByText('Belum ada data tercatat.')).not.toBeInTheDocument();
    expect(screen.queryByText(END_HINT)).not.toBeInTheDocument();
  });

  it('REWORK highlights itself, disables the other starts; END waits for a defect (AC-06.3)', async () => {
    renderDefect();
    await startRework();
    expect(button('REWORK')).toHaveAttribute('aria-pressed', 'true');
    expect(button('B-GRADE')).toBeDisabled();
    expect(button('END INSPECTION')).toBeDisabled();
    expect(screen.getByText(END_HINT)).toBeVisible();
    expect(button('END INSPECTION')).toHaveAccessibleDescription(END_HINT);
    expect(pill('QUARTER')).toBeEnabled();
    expect(screen.getByText('Pilih area sepatu')).toBeVisible();
    expect(screen.getByText(/PO 0903359388/).closest('p')).toHaveTextContent('REWORK');

    await openFamily();
    fireEvent.click(option(D1!.name));
    await toast('+1 Defect');
    expect(button('END INSPECTION')).toBeEnabled();
    expect(screen.queryByText(END_HINT)).not.toBeInTheDocument();
    expect(button('END INSPECTION')).not.toHaveAttribute('aria-describedby');
  });

  it('B-GRADE starts a B-GRADE inspection and END waits for a defect (AC-06.3)', async () => {
    renderDefect();
    fireEvent.click(button('B-GRADE'));
    await toast('Inspeksi B-GRADE dimulai');
    expect(button('B-GRADE')).toHaveAttribute('aria-pressed', 'true');
    expect(button('REWORK')).toBeDisabled();
    expect(session().active?.type).toBe('B-GRADE');
    expect(button('END INSPECTION')).toBeDisabled();
    expect(screen.getByText(END_HINT)).toBeVisible();

    await openFamily();
    fireEvent.click(option(D1!.name));
    await toast('+1 Defect dan B-Grade');
    expect(button('END INSPECTION')).toBeEnabled();
    expect(screen.queryByText(END_HINT)).not.toBeInTheDocument();
  });

  it('PSI lv.1 has no NO DEFECT; END needs a defect; Qty Inspection stays independent (ADR-019)', async () => {
    await asLv1();
    renderDefect();
    expect(screen.queryByRole('button', { name: 'NO DEFECT' })).not.toBeInTheDocument();
    expect(screen.getByText(/isi QTY INSPECTION di Home\.$/)).toBeVisible();
    // No NO DEFECT row for PSI lv.1, even with a legacy NO_DEFECT event (ADR-019 decision 9).
    expect(historyRows()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Ubah NO DEFECT' })).not.toBeInTheDocument();
    expect(screen.getByText(EMPTY_HISTORY)).toBeVisible();
    await startRework();
    expect(button('END INSPECTION')).toBeDisabled();
    await openFamily();
    fireEvent.click(option(D1!.name));
    await toast('+1 Defect');
    fireEvent.click(button('END INSPECTION'));
    await toast('Inspeksi selesai. 1 defect tercatat');
    expect(totals(session())).toMatchObject({ qtyInspection: null, qtyDefect: 1 });
    expect(screen.getByText('Mulai inspeksi')).toBeVisible();
  });

  it('PSI lv.2: END INSPECTION counts the pair (ADR-021)', async () => {
    renderDefect();
    await startRework();
    expect(button('NO DEFECT')).toBeDisabled();
    await openFamily();
    fireEvent.click(option(D1!.name));
    await toast('+1 Defect');
    fireEvent.click(button('END INSPECTION'));
    await toast('Inspeksi selesai. 1 defect tercatat');
    expect(totals(session())).toMatchObject({ qtyInspection: 1, qtyAGrade: 0, qtyDefect: 1 });
    expect(button('END INSPECTION')).toBeDisabled();
    expect(screen.getByText('Mulai inspeksi')).toBeVisible();
  });
});

describe('NO DEFECT, PSI lv.2 (ADR-021)', () => {
  it('shows the NO DEFECT pairs as one history row; UNDO takes them back one at a time (FR-08, FR-09)', async () => {
    renderDefect();
    for (let i = 1; i <= 3; i++) {
      fireEvent.click(button('NO DEFECT'));
      await waitFor(() => expect(session().noDefect).toBe(i));
    }
    const row = () => historyRows()[0]!;
    expect(historyRows()).toHaveLength(1);
    expect(row()).toHaveTextContent('NO DEFECT');
    expect(row()).toHaveTextContent('A-Grade');
    expect(row().querySelector('.m100-hist__q')).toHaveTextContent('3');

    fireEvent.click(bar('UNDO'));
    await waitFor(() => expect(session().noDefect).toBe(2));
    expect(row().querySelector('.m100-hist__q')).toHaveTextContent('2');
    expect(bar('UNDO')).toBeEnabled();
    fireEvent.click(bar('UNDO'));
    await waitFor(() => expect(session().noDefect).toBe(1));
    fireEvent.click(bar('UNDO'));
    await waitFor(() => expect(session().noDefect).toBe(0));
    // The row stays at 0 (ADR-023).
    expect(historyRows()).toHaveLength(1);
    expect(row().querySelector('.m100-hist__q')).toHaveTextContent('0');
    expect(bar('UNDO')).toBeDisabled();
  });

  it('hides the NO DEFECT row while an inspection runs, and UNDO stops at it', async () => {
    renderDefect();
    fireEvent.click(button('NO DEFECT'));
    await toast('No Defect tercatat. A-Grade +1');
    await startRework();
    expect(historyRows()).toHaveLength(0);
    expect(screen.getByText(EMPTY_HISTORY)).toBeVisible();
    fireEvent.click(bar('UNDO'));
    await toast('Inspeksi dibatalkan');
    // Back to no inspection: the row shows again, but UNDO does not reach the earlier NO DEFECT.
    expect(historyRows()).toHaveLength(1);
    expect(historyRows()[0]!.querySelector('.m100-hist__q')).toHaveTextContent('1');
    expect(bar('UNDO')).toBeDisabled();
  });

  it('records one A-Grade pair at once; UNDO right after cancels it', async () => {
    renderDefect();
    fireEvent.click(button('NO DEFECT'));
    await toast('No Defect tercatat. A-Grade +1');
    expect(totals(session())).toMatchObject({ qtyInspection: 1, qtyAGrade: 1 });
    expect(button('END INSPECTION')).toBeDisabled();
    expect(button('REWORK')).toBeEnabled();

    fireEvent.click(bar('UNDO'));
    await toast('No Defect dibatalkan');
    expect(totals(session())).toMatchObject({ qtyInspection: 0, qtyAGrade: 0 });
    expect(bar('UNDO')).toBeDisabled();
  });

  it('disables NO DEFECT, REWORK and B-GRADE at the partial quantity, and says why', async () => {
    await store.getState().setPartial(PO.po, { number: 1, qty: 2 });
    renderDefect();
    fireEvent.click(button('NO DEFECT'));
    await toast('No Defect tercatat. A-Grade +1');
    await startRework();
    await openFamily();
    fireEvent.click(option(D1!.name));
    await toast('+1 Defect');
    fireEvent.click(button('END INSPECTION'));
    await toast('Inspeksi selesai. 1 defect tercatat');
    for (const name of ['NO DEFECT', 'REWORK', 'B-GRADE']) expect(button(name)).toBeDisabled();
    expect(screen.getByText(/Qty Inspection sudah 2 pasang, maksimum PO ini/)).toBeVisible();
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

  it('lists only the current inspection while Home stays session-wide (AC-06.3, AC-09.2)', async () => {
    renderDefect();
    await startRework();
    await openFamily();
    fireEvent.click(option(D1!.name));
    await toast('+1 Defect');
    fireEvent.click(button('END INSPECTION'));
    await toast('Inspeksi selesai. 1 defect tercatat');

    fireEvent.click(button('B-GRADE'));
    await toast('Inspeksi B-GRADE dimulai');
    // A new start begins with an empty list (AC-06.3).
    expect(historyRows()).toHaveLength(0);
    expect(screen.getByText(EMPTY_HISTORY)).toBeVisible();
    await openFamily();
    fireEvent.click(option(D1!.name));
    await toast('+1 Defect dan B-Grade');
    fireEvent.click(option(D2!.name));
    await waitFor(() => expect(historyRows()).toHaveLength(2));

    // Only the active B-GRADE inspection: the ended REWORK tap stays on Home and in the export.
    expect(historyRows()[0]).toHaveTextContent('B-GRADE');
    expect(historyRows().some((row) => row.textContent?.includes('REWORK'))).toBe(false);
    expect(findings(session())).toHaveLength(3);
    expect(option(D1!.name)).toHaveTextContent(/1$/);
    // PSI lv.2: the ended REWORK pair counts, the active B-GRADE one not yet (ADR-021).
    expect(totals(session())).toMatchObject({ qtyInspection: 1, qtyDefect: 3, qtyBGrade: 2 });
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
  it('UNDO removes the last defect, then cancels the inspection, then is disabled (AC-08.1, AC-06.3)', async () => {
    renderDefect();
    await startRework();
    await openFamily();
    fireEvent.click(option(D1!.name));
    await toast('+1 Defect');
    expect(button('END INSPECTION')).toBeEnabled();

    fireEvent.click(bar('UNDO'));
    await toast('Defect terakhir dibatalkan');
    expect(historyRows()).toHaveLength(0);
    expect(screen.getByText(EMPTY_HISTORY)).toBeVisible();
    expect(session().active?.defects).toHaveLength(0);
    // AC-06.3: the only defect is gone, so END is disabled again and the hint is back.
    expect(button('END INSPECTION')).toBeDisabled();
    expect(screen.getByText(END_HINT)).toBeVisible();

    fireEvent.click(bar('UNDO'));
    await toast('Inspeksi dibatalkan');
    expect(totals(session()).qtyInspection).toBe(0);
    expect(bar('UNDO')).toBeDisabled();
    expect(screen.getByText('Mulai inspeksi')).toBeVisible();
    expect(screen.queryByText(END_HINT)).not.toBeInTheDocument();
    await waitFor(() => expect(store.getState().view.defectPath).toEqual(NO_PATH));
  });

  it('UNDO stays disabled after END and never changes an entered Qty Inspection', async () => {
    await asLv1();
    await store.getState().tap(PO.po, { type: 'SET_QTY_INSPECTION', qty: 30 });
    renderDefect();
    await startRework();
    await openFamily();
    fireEvent.click(option(D1!.name));
    await toast('+1 Defect');
    fireEvent.click(button('END INSPECTION'));
    await toast('Inspeksi selesai. 1 defect tercatat');
    expect(bar('UNDO')).toBeDisabled();
    expect(totals(session()).qtyInspection).toBe(30);
  });

  it('UNDO never reaches an ended inspection', async () => {
    renderDefect();
    await startRework();
    await openFamily();
    fireEvent.click(option(D1!.name));
    await toast('+1 Defect');
    fireEvent.click(button('END INSPECTION'));
    await toast('Inspeksi selesai. 1 defect tercatat');
    expect(bar('UNDO')).toBeDisabled();
    // The ended inspection's findings leave the list; PSI lv.2 keeps only the NO DEFECT row (ADR-023).
    expect(historyRows()).toHaveLength(1);
    expect(historyRows()[0]).toHaveTextContent('NO DEFECT');
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

describe('NO DEFECT total, S6a (PSI lv.2, ADR-023)', () => {
  const dialog = () => screen.getByRole('dialog', { name: 'NO DEFECT (A-Grade)' });
  const queryDialog = () => screen.queryByRole('dialog', { name: 'NO DEFECT (A-Grade)' });
  const key = (name: string) => fireEvent.click(within(dialog()).getByRole('button', { name }));
  const typed = (digits: string) => {
    key('HAPUS');
    for (const d of digits) key(d);
  };
  const readout = () => dialog().querySelector('.m100-pad__out')!;
  const simpan = () => within(dialog()).getByRole('button', { name: 'SIMPAN' });
  const qtyOfRow = () => noDefectRow().querySelector('.m100-hist__q');
  const setEvents = async () =>
    (await db.events.toArray()).filter((e) => e.type === 'SET_NO_DEFECT');

  async function endedRework() {
    await startRework();
    await openFamily();
    fireEvent.click(option(D1!.name));
    await toast('+1 Defect');
    fireEvent.click(button('END INSPECTION'));
    await toast('Inspeksi selesai. 1 defect tercatat');
  }

  it('opens pre-filled from the row with the maximum, and SIMPAN stores the total first', async () => {
    renderDefect();
    fireEvent.click(noDefectRow());
    expect(dialog()).toHaveTextContent('PO 0903359388');
    expect(
      within(dialog()).getByRole('group', { name: 'Jumlah pasang tanpa defect' }),
    ).toBeVisible();
    expect(readout()).toHaveTextContent('0');
    expect(within(dialog()).getByText('Maksimum 10.002 pasang')).toBeVisible();

    typed('120');
    fireEvent.click(simpan());
    await toast('No Defect diubah menjadi 120');
    expect(queryDialog()).not.toBeInTheDocument();
    // NFR-05: the event is in IndexedDB.
    expect((await setEvents()).map((e) => e.type === 'SET_NO_DEFECT' && e.qty)).toEqual([120]);
    expect(totals(session(), { orderQty: PO.orderQty, partial: null })).toMatchObject({
      qtyInspection: 120,
      qtyAGrade: 120,
    });
    expect(qtyOfRow()).toHaveTextContent('120');
    expect(noDefectRow()).toHaveClass('m100-flash');

    // Later taps add one each; the dialog then opens with the new total.
    fireEvent.click(button('NO DEFECT'));
    await waitFor(() => expect(session().noDefect).toBe(121));
    fireEvent.click(noDefectRow());
    expect(readout()).toHaveTextContent('121');
  });

  it('shows the partial and the maximum minus REWORK / B-GRADE pairs; above it SIMPAN is disabled', async () => {
    await store.getState().setPartial(PO.po, { number: 1, qty: 1200 });
    renderDefect();
    await endedRework();
    fireEvent.click(noDefectRow());
    expect(dialog()).toHaveTextContent('P1 · 1.200 dari 10.002');
    expect(within(dialog()).getByText('Maksimum 1.199 pasang')).toBeVisible();
    typed('1200');
    expect(within(dialog()).getByText('Melebihi maksimum 1.199 pasang')).toHaveClass(
      'm100-pad__msg--bad',
    );
    expect(simpan()).toBeDisabled();
    typed('1199');
    expect(simpan()).toBeEnabled();
    fireEvent.click(simpan());
    await toast('No Defect diubah menjadi 1.199');
    expect(totals(session(), store.getState().pos[0]).qtyInspection).toBe(1200);
  });

  it('saves empty as 0; an unchanged value closes without an event or toast', async () => {
    renderDefect();
    for (let i = 1; i <= 2; i++) {
      fireEvent.click(button('NO DEFECT'));
      await waitFor(() => expect(session().noDefect).toBe(i));
    }
    fireEvent.click(noDefectRow());
    fireEvent.click(simpan());
    await waitFor(() => expect(queryDialog()).not.toBeInTheDocument());
    expect(await setEvents()).toHaveLength(0);
    expect(screen.queryByText(/No Defect diubah/)).not.toBeInTheDocument();

    fireEvent.click(noDefectRow());
    key('HAPUS');
    fireEvent.click(simpan());
    await toast('No Defect diubah menjadi 0');
    expect(session().noDefect).toBe(0);
    expect(qtyOfRow()).toHaveTextContent('0');
  });

  it('BATAL, the close button and Escape change nothing', async () => {
    renderDefect();
    for (const close of [
      () => fireEvent.click(within(dialog()).getByRole('button', { name: 'BATAL' })),
      () => fireEvent.click(within(dialog()).getByRole('button', { name: 'Tutup' })),
      () => fireEvent.keyDown(document, { key: 'Escape' }),
    ]) {
      fireEvent.click(noDefectRow());
      typed('55');
      close();
      await waitFor(() => expect(queryDialog()).not.toBeInTheDocument());
    }
    expect(await setEvents()).toHaveLength(0);
    expect(session().noDefect).toBe(0);
  });

  it('UNDO takes a saved total back to the total before it', async () => {
    renderDefect();
    fireEvent.click(button('NO DEFECT'));
    await toast('No Defect tercatat. A-Grade +1');
    fireEvent.click(noDefectRow());
    typed('120');
    fireEvent.click(simpan());
    await toast('No Defect diubah menjadi 120');
    fireEvent.click(button('NO DEFECT'));
    await waitFor(() => expect(session().noDefect).toBe(121));

    fireEvent.click(bar('UNDO'));
    await toast('No Defect dibatalkan');
    expect(qtyOfRow()).toHaveTextContent('120');
    fireEvent.click(bar('UNDO'));
    await toast('Perubahan No Defect dibatalkan');
    expect(qtyOfRow()).toHaveTextContent('1');
    expect(session().noDefect).toBe(1);
    expect(bar('UNDO')).toBeEnabled();
  });

  it('is hidden during an inspection and stays tappable at the maximum, so the total can be lowered', async () => {
    await store.getState().setPartial(PO.po, { number: 1, qty: 3 });
    renderDefect();
    fireEvent.click(noDefectRow());
    typed('3');
    fireEvent.click(simpan());
    await toast('No Defect diubah menjadi 3');
    expect(button('NO DEFECT')).toBeDisabled();
    expect(screen.getByText(/Qty Inspection sudah 3 pasang, maksimum PO ini/)).toBeVisible();

    fireEvent.click(noDefectRow());
    typed('2');
    fireEvent.click(simpan());
    await toast('No Defect diubah menjadi 2');
    expect(button('REWORK')).toBeEnabled();

    await startRework();
    expect(screen.queryByRole('button', { name: 'Ubah NO DEFECT' })).not.toBeInTheDocument();
    expect(screen.getByText(EMPTY_HISTORY)).toBeVisible();
  });
});
