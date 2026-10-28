import { useState } from 'react';
import {
  checkQtyInspection,
  formatCount,
  formatPartial,
  qtyInspectionLimits,
  totals,
} from '@m100/shared';
import { Overlay } from '../app/Overlay';
import { useToast } from '../app/toastContext';
import type { PoRow } from '../db/schema';
import { useAppStore, type PoSession } from '../state/store';
import { Button, Dialog, Notice, NumberPad } from '../ui';

export function QtyInspectionDialog({
  po,
  session,
  onClose,
}: {
  po: PoRow;
  session: PoSession;
  onClose: () => void;
}) {
  const tap = useAppStore((s) => s.tap);
  const toast = useToast();
  const [digits, setDigits] = useState(() => session.state.qtyInspection?.toString() ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const t = totals(session.state, po);
  const { min, max } = qtyInspectionLimits(t.qtyDefect, po.partial, po.orderQty);
  const qty = digits === '' ? null : Number(digits);
  const invalid = checkQtyInspection(qty, { min, max }) !== null;
  const limit = po.partial ? 'partial' : 'Qty Order';
  async function save() {
    if (qty === null || invalid || busy) return;
    setBusy(true);
    try {
      const saved = await tap(po.po, { type: 'SET_QTY_INSPECTION', qty });
      if (!saved) {
        setProblem('Jumlah berubah. Periksa batas Qty Inspection.');
        setBusy(false);
        return;
      }
      onClose();
      toast('Qty Inspection disimpan');
    } catch (error) {
      console.error(error);
      setProblem('Qty Inspection gagal disimpan. Coba lagi.');
      setBusy(false);
    }
  }
  return (
    <Overlay onDismiss={busy ? undefined : onClose}>
      <Dialog title="QTY INSPECTION" onClose={busy ? false : onClose}>
        <p className="dialog__text">PO {po.po}</p>
        {po.partial ? (
          <p className="dialog__text">{formatPartial(po.partial, po.orderQty)}</p>
        ) : null}
        <NumberPad
          label="Qty inspection"
          value={digits}
          min={min}
          max={max}
          unit="PASANG"
          onChange={busy ? undefined : setDigits}
          hint={
            min > max
              ? ''
              : `Jumlah pasang yang diinspeksi, ${formatCount(min)} sampai ${formatCount(max)}.`
          }
        />
        {min > max ? (
          <Notice tone="danger">
            Jumlah defect ({formatCount(t.qtyDefect)}) melebihi {limit} {formatCount(max)} pasang.
            Perbaiki defect{po.partial ? ' atau partial' : ''} dulu.
          </Notice>
        ) : t.qtyDefect > 0 ? (
          <p className="dialog__text">{formatCount(t.qtyDefect)} defect sudah tercatat.</p>
        ) : null}
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
