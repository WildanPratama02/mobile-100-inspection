import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataSourcesContext } from '../app/dataSources';
import { ToastProvider } from '../app/toast';
import { createFixtureSources } from '../data/fixtures/fixtureSources';
import { ALL_PO_MASTER } from '../data/fixtures/pos';
import { PoSearchError, type DataSources } from '../data/sources';
import { createDb, type Auth, type M100Db } from '../db/schema';
import { AppStoreContext, createAppStore, selectedPo, type AppStore } from '../state/store';
import { AddPoDialog } from './AddPoDialog';

const AUTH: Auth = {
  username: 'ANDI CONTOH',
  level: 'PSI lv.1',
  factory: 'F 1',
  cell: 'F1-01',
  token: null,
  tokenExpiresAt: null,
};

let db: M100Db;
let store: AppStore;
let onClose: () => void;

beforeEach(async () => {
  db = createDb(`addpo-${crypto.randomUUID()}`);
  store = createAppStore(db);
  await store.getState().hydrate();
  await store.getState().login(AUTH);
  onClose = vi.fn();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
});

function renderDialog(sources: DataSources = createFixtureSources()) {
  render(
    <DataSourcesContext.Provider value={sources}>
      <AppStoreContext.Provider value={store}>
        <ToastProvider>
          <AddPoDialog onClose={onClose} />
        </ToastProvider>
      </AppStoreContext.Provider>
    </DataSourcesContext.Provider>,
  );
}

const dialog = () => screen.getByRole('dialog', { name: 'Tambah PO' });
const poField = () => within(dialog()).getByRole('button', { name: /^PO NUMBER/ });
const searchBox = () => screen.getByRole('searchbox', { name: 'Cari PO, artikel, atau model' });
const addButton = () => screen.getByRole('button', { name: 'ADD TO PO LIST' });

function type(q: string) {
  fireEvent.change(searchBox(), { target: { value: q } });
}

async function choose(q: string, po: string) {
  fireEvent.click(poField());
  type(q);
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(`^${po}`) }));
}

const detail = (label: string) =>
  within(screen.getByLabelText('Detail PO')).getByText(label).nextElementSibling?.textContent;

function pad(digits: string) {
  const keys = screen.getByRole('group', { name: 'Qty partial' });
  for (const d of digits) fireEvent.click(within(keys).getByRole('button', { name: d }));
}

describe('S4 Add PO search (doc 05 §9.1, FR-03.2)', () => {
  it('opens a search box with focus and asks for 3 characters first', () => {
    renderDialog();
    fireEvent.click(poField());
    expect(searchBox()).toHaveFocus();
    expect(screen.getByText('Ketik minimal 3 karakter')).toBeInTheDocument();
    type('09');
    expect(screen.getByText('Ketik minimal 3 karakter')).toBeInTheDocument();
  });

  it('searches PO, article and model and shows "model · destinasi"', async () => {
    renderDialog();
    fireEvent.click(poField());
    type('skate');
    expect(screen.getByText('Mencari…')).toBeInTheDocument();
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'CX-0902368700SKATE CONTOH · AUSTRALIA',
      '0903361120SKATE CONTOH MID · CANADA',
    ]);
  });

  it('asks for at most 20 results', async () => {
    const sources = createFixtureSources();
    const search = vi.spyOn(sources.pos, 'search');
    renderDialog(sources);
    fireEvent.click(poField());
    type('0903');
    await screen.findAllByRole('option');
    expect(search).toHaveBeenLastCalledWith('0903', 20);
  });

  it('says when nothing matches', async () => {
    renderDialog();
    fireEvent.click(poField());
    type('zzz');
    expect(await screen.findByText('PO tidak ditemukan')).toBeInTheDocument();
  });

  it('disables a PO already in the list (AC-03.1)', async () => {
    await store.getState().addPo(ALL_PO_MASTER[1]!, null);
    renderDialog();
    fireEvent.click(poField());
    type('0902368');
    const listed = await screen.findByRole('option', { name: /^CX-0902368685/ });
    expect(listed).toBeDisabled();
    expect(listed).toHaveTextContent('· sudah di list');
    expect(screen.getByRole('option', { name: /^CX-0902368700/ })).toBeEnabled();
  });

  it('needs a connection (AC-13.3)', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderDialog();
    fireEvent.click(poField());
    type('0903');
    expect(
      screen.getByText('Cari PO butuh koneksi. Hubungkan Wi-Fi, lalu coba lagi.'),
    ).toBeInTheDocument();
  });

  it("shows the API's detail when the search is refused", async () => {
    const sources = createFixtureSources();
    vi.spyOn(sources.pos, 'search').mockRejectedValue(new PoSearchError('Query tidak valid.'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderDialog(sources);
    fireEvent.click(poField());
    type('0903');
    expect(await screen.findByRole('alert')).toHaveTextContent('Query tidak valid.');
  });
});

describe('S4 details and ADD TO PO LIST (doc 05 §9.1–9.2)', () => {
  it('shows ":" until a PO is chosen, then its details in id-ID', async () => {
    renderDialog();
    expect(detail('Qty Order')).toBe(':');
    expect(addButton()).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /PO PARTIAL/ })).toBeDisabled();

    await choose('0903359388', '0903359388');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(poField()).toHaveTextContent('0903359388');
    expect(detail('PO Number')).toBe('0903359388');
    expect(detail('Artikel')).toBe('IH0001');
    expect(detail('Model')).toBe('RUNNER CONTOH 1');
    expect(detail('Destination')).toBe('JAPAN');
    expect(detail('Qty Order')).toBe('10.002');
    expect(detail('PODD')).toBe('02 Nov 2026');
    expect(detail('CRD')).toBe('20 Nov 2026');
    expect(addButton()).toBeEnabled();
  });

  it('shows "-" for an empty PO date', async () => {
    renderDialog();
    await choose('0903359402', '0903359402');
    expect(detail('PODD')).toBe('-');
  });

  it('adds the PO, selects it and closes with a toast', async () => {
    renderDialog();
    await choose('CX-09', 'CX-0902368685');
    fireEvent.click(addButton());
    expect(await screen.findByText('PO ditambahkan')).toBeInTheDocument();
    expect(onClose).toHaveBeenCalled();
    expect(selectedPo(store.getState())).toMatchObject({ po: 'CX-0902368685', partial: null });
  });

  it('with PO PARTIAL: needs a quantity from 1 to Qty Order (AC-03.6)', async () => {
    renderDialog();
    await choose('0903359388', '0903359388');
    fireEvent.click(screen.getByRole('checkbox', { name: /PO PARTIAL/ }));
    expect(screen.getByText('P1')).toBeInTheDocument();
    expect(screen.getByText('Masukkan jumlah pasang, 1 sampai 10.002')).toBeInTheDocument();
    expect(addButton()).toBeDisabled();

    pad('0');
    expect(screen.getByText('Minimal 1 pasang')).toBeInTheDocument();
    expect(addButton()).toBeDisabled();

    pad('10003');
    expect(screen.getByText('Maksimum 10.002 pasang')).toBeInTheDocument();
    expect(addButton()).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'HAPUS' }));
    pad('1200');
    fireEvent.click(screen.getByRole('button', { name: 'Tambah' }));
    expect(screen.getByText('P2')).toBeInTheDocument();
    expect(addButton()).toBeEnabled();

    fireEvent.click(addButton());
    await waitFor(() =>
      expect(selectedPo(store.getState())?.partial).toEqual({ number: 2, qty: 1200 }),
    );
  });

  it('unticking PO PARTIAL discards the number and the quantity', async () => {
    renderDialog();
    await choose('0903359388', '0903359388');
    const box = screen.getByRole('checkbox', { name: /PO PARTIAL/ });
    fireEvent.click(box);
    pad('5');
    fireEvent.click(box);
    expect(screen.queryByRole('group', { name: 'Qty partial' })).not.toBeInTheDocument();
    fireEvent.click(box);
    expect(screen.getByRole('group', { name: 'Qty partial' })).toHaveTextContent('0');
    expect(addButton()).toBeDisabled();
  });
});
