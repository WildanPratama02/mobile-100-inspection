/**
 * S5c REWORK AND APPROVED (doc 05 §10c, FR-16, BR-11): the pairs that went to REWORK, were repaired and passed
 * the re-inspection, entered with the app's number pad for both PSI levels. Whole numbers from 0 to INSPECTION
 * REWORK QTY, or empty (sent as 0). While a saved value is not valid after UNDO, the maximum may be 0 so the PSI
 * can save 0 or empty. SIMPAN writes `SET_REWORK_APPROVED` to the tablet before the dialog closes (NFR-05).
 */
import { useState } from 'react';
import { formatCount } from '@m100/shared';
import { Overlay } from '../app/Overlay';
import type { PoRow } from '../db/schema';
import { useAppStore, type PoSession } from '../state/store';
import { Button, Dialog, Notice, NumberPad } from '../ui';

export interface ReworkApprovedDialogProps {
  po: PoRow;
  session: PoSession;
  onClose: () => void;
}

export function ReworkApprovedDialog({ po, session, onClose }: ReworkApprovedDialogProps) {
  const tap = useAppStore((s) => s.tap);
  const [digits, setDigits] = useState(() => session.state.reworkApproved?.toString() ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const max = session.state.counts.rework;
  const qty = digits === '' ? null : Number(digits);
  const invalid = qty !== null && qty > max;

  async function save() {
    if (invalid || busy) return;
    setBusy(true);
    try {
      const saved = await tap(po.po, { type: 'SET_REWORK_APPROVED', qty });
      if (!saved) {
        setProblem('REWORK AND APPROVED gagal disimpan. Coba lagi.');
        setBusy(false);
        return;
      }
      onClose();
    } catch (error) {
      console.error(error);
      setProblem('REWORK AND APPROVED gagal disimpan. Coba lagi.');
      setBusy(false);
    }
  }

  return (
    <Overlay onDismiss={busy ? undefined : onClose}>
      <Dialog title="REWORK AND APPROVED" onClose={busy ? false : onClose}>
        <p className="dialog__text">
          Pasang rework yang sudah diperbaiki dan lolos inspeksi ulang (maks. {formatCount(max)})
        </p>
        <NumberPad
          value={digits}
          min={0}
          max={max}
          unit="PASANG"
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
