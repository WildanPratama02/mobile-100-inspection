/**
 * S4 Add PO (doc 05 §9, FR-03.1–03.5, ADR-013): search a PO, check its details, optionally set PO PARTIAL,
 * then ADD TO PO LIST. The search box is the only place the device keyboard is used (G1).
 */
import { useEffect, useState } from 'react';
import { formatCount, formatDate, type Po } from '@m100/shared';
import { useDataSources } from '../app/dataSources';
import { Overlay } from '../app/Overlay';
import { useToast } from '../app/toastContext';
import { useOnline } from '../app/useOnline';
import { PO_QUERY_MIN, PO_RESULTS_MAX, PoSearchError } from '../data/sources';
import { useAppStore } from '../state/store';
import { Button, Dialog, List, Notice, SelectField } from '../ui';
import { NO_PARTIAL, partialOf } from './partial';
import { PartialFields } from './PartialFields';
import './screens.css';

/** Wait after the last keystroke before searching; `GET /pos` allows 60 requests a minute (doc 04 §7). */
export const SEARCH_DELAY_MS = 250;

/** The answer to one query; a query without its answer yet is still searching. */
type Answer = { q: string; found: Po[] } | { q: string; detail: string };

export interface AddPoDialogProps {
  onClose: () => void;
}

export function AddPoDialog({ onClose }: AddPoDialogProps) {
  const { pos: source } = useDataSources();
  const addPo = useAppStore((s) => s.addPo);
  const listed = useAppStore((s) => s.pos);
  const online = useOnline();
  const toast = useToast();
  const [chosen, setChosen] = useState<Po | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [draft, setDraft] = useState(NO_PARTIAL);
  const [busy, setBusy] = useState(false);

  const q = query.trim();
  const tooShort = q.length < PO_QUERY_MIN;
  useEffect(() => {
    if (!searching || tooShort || !online) return;
    // Only the latest query's answer is kept.
    let current = true;
    const timer = window.setTimeout(() => {
      source.search(q, PO_RESULTS_MAX).then(
        (found) => {
          if (current) setAnswer({ q, found });
        },
        (error: unknown) => {
          if (!current) return;
          console.error(error);
          setAnswer({
            q,
            detail:
              error instanceof PoSearchError
                ? error.detail
                : 'Terjadi kesalahan server. Data tetap tersimpan di tablet.',
          });
        },
      );
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [searching, q, tooShort, online, source]);
  const result = answer?.q === q ? answer : null;

  const partial = chosen ? partialOf(draft, chosen.orderQty) : undefined;
  const canAdd = chosen !== null && partial !== undefined && !busy;

  async function add() {
    if (!chosen || partial === undefined) return;
    setBusy(true);
    try {
      await addPo(chosen, partial);
      onClose();
      toast('PO ditambahkan');
    } catch (error) {
      console.error(error);
      setBusy(false);
    }
  }

  const isListed = (po: string) => listed.some((p) => p.po === po);

  return (
    <Overlay onDismiss={onClose}>
      <Dialog title="Tambah PO" onClose={onClose} className="addpo">
        <SelectField
          id="addpo-po"
          label="PO NUMBER"
          placeholder="PO NUMBER"
          mono
          value={chosen?.po ?? null}
          open={searching}
          onClick={() => setSearching((open) => !open)}
        />

        {searching ? (
          <div className="addpo__panel">
            <input
              type="search"
              className="addpo__search"
              placeholder="Cari PO, artikel, atau model"
              aria-label="Cari PO, artikel, atau model"
              autoComplete="off"
              // The panel exists to type into; focus lands there at once (doc 05 §9.1).
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {!online ? (
              <Notice tone="warning">
                Cari PO butuh koneksi. Hubungkan Wi-Fi, lalu coba lagi.
              </Notice>
            ) : tooShort ? (
              <p className="addpo__hint">Ketik minimal 3 karakter</p>
            ) : !result ? (
              <p className="addpo__hint">Mencari…</p>
            ) : 'detail' in result ? (
              <Notice tone="danger">{result.detail}</Notice>
            ) : result.found.length === 0 ? (
              <p className="addpo__hint">PO tidak ditemukan</p>
            ) : (
              <List role="listbox" className="addpo__results">
                {result.found.map((po) => {
                  const already = isListed(po.po);
                  return (
                    <button
                      key={po.po}
                      type="button"
                      role="option"
                      aria-selected={po.po === chosen?.po}
                      className="m100-row addpo__option"
                      disabled={already}
                      onClick={() => {
                        setChosen(po);
                        setSearching(false);
                      }}
                    >
                      <span className="m100-row__t">
                        <span className="addpo__po">{po.po}</span>
                        <small>
                          {po.model} · {po.destination}
                          {already ? ' · sudah di list' : ''}
                        </small>
                      </span>
                    </button>
                  );
                })}
              </List>
            )}
          </div>
        ) : null}

        <dl className="addpo__details" aria-label="Detail PO">
          <Detail label="PO Number" value={chosen?.po} mono />
          <Detail label="Artikel" value={chosen?.article} />
          <Detail label="Model" value={chosen?.model} />
          <Detail label="Destination" value={chosen?.destination} />
          <Detail label="Qty Order" value={chosen && formatCount(chosen.orderQty)} />
          <Detail label="PODD" value={chosen && formatDate(chosen.podd)} />
          <Detail label="CRD" value={chosen && formatDate(chosen.crd)} />
        </dl>

        <PartialFields
          draft={draft}
          orderQty={chosen?.orderQty ?? 0}
          disabled={!chosen}
          onChange={setDraft}
        />

        <Button variant="primary" size="lg" block disabled={!canAdd} onClick={() => void add()}>
          ADD TO PO LIST
        </Button>
      </Dialog>
    </Overlay>
  );
}

interface DetailProps {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}

/** A read-only detail; ":" until a PO is chosen (doc 05 §9.1 step 2). */
function Detail({ label, value, mono }: DetailProps) {
  const empty = value == null;
  return (
    <div className="addpo__detail">
      <dt>{label}</dt>
      <dd className={empty ? 'addpo__empty' : mono ? 'addpo__po' : undefined}>
        {empty ? ':' : value}
      </dd>
    </div>
  );
}
