/**
 * S6a NO DEFECT dialog (doc 05 §11.6, ADR-023, FR-09, AC-09.3): PSI lv.2 sets the session's NO DEFECT total
 * (Qty A-Grade) with the app's number pad instead of tapping NO DEFECT pair by pair. The value is the new total,
 * a whole number from 0 to the partial quantity (else Qty Order) minus the REWORK and B-GRADE pairs; empty saves
 * 0. SIMPAN writes `SET_NO_DEFECT` to the tablet before the dialog closes (NFR-05); an unchanged value writes
 * nothing.
 */
import { useState } from 'react';
import { formatCount, formatPartial, noDefectMax, type SessionState } from '@m100/shared';
import { Overlay } from '../app/Overlay';
import { useToast } from '../app/toastContext';
import type { PoRow } from '../db/schema';
import { useAppStore } from '../state/store';
import { Button, Dialog, Notice, NumberPad } from '../ui';

export interface NoDefectDialogProps {
  po: PoRow;
  /** The PSI lv.2 session (`TAPPED`) with no inspection running. */
  state: SessionState;
  onClose: () => void;
  /** After a total was saved and the dialog closed: the Defect screen flashes the NO DEFECT row. */
  onSaved?: (qty: number) => void;
}

export function NoDefectDialog({ po, state, onClose, onSaved }: NoDefectDialogProps) {
  const tap = useAppStore((s) => s.tap);
  const toast = useToast();
  const [digits, setDigits] = useState(() => String(state.noDefect));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const max = noDefectMax(state, po) ?? 0;
  const qty = digits === '' ? 0 : Number(digits);
  const invalid = qty > max;

  async function save() {
    if (invalid || busy) return;
    if (qty === state.noDefect) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const saved = await tap(po.po, { type: 'SET_NO_DEFECT', qty });
      if (!saved) {
        setProblem('NO DEFECT gagal disimpan. Coba lagi.');
        setBusy(false);
        return;
      }
      onClose();
      onSaved?.(qty);
      toast(`No Defect diubah menjadi ${formatCount(qty)}`);
    } catch (error) {
      console.error(error);
      setProblem('NO DEFECT gagal disimpan. Coba lagi.');
      setBusy(false);
    }
  }

  return (
    <Overlay onDismiss={busy ? undefined : onClose}>
      <Dialog title="NO DEFECT (A-Grade)" onClose={busy ? false : onClose}>
        <p className="dialog__text">PO {po.po}</p>
        {po.partial ? (
          <p className="dialog__text">{formatPartial(po.partial, po.orderQty)}</p>
        ) : null}
        <NumberPad
          label="Jumlah pasang tanpa defect"
          value={digits}
          min={0}
          max={max}
          unit="PASANG"
          hint={`Maksimum ${formatCount(max)} pasang`}
          overMessage={`Melebihi maksimum ${formatCount(max)} pasang`}
          onChange={busy ? undefined : setDigits}
        />
        {problem ? <Notice tone="danger">{problem}</Notice> : null}
        <div className="dialog__actions">
          <Button disabled={busy} onClick={onClose}>
            BATAL
          </Button>
          <Button variant="primary" disabled={invalid || busy} onClick={() => void save()}>
            SIMPAN
          </Button>
        </div>
      </Dialog>
    </Overlay>
  );
}
