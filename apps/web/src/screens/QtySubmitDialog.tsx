import { formatCount, totals } from '@m100/shared';
import { Overlay } from '../app/Overlay';
import type { PoRow } from '../db/schema';
import type { PoSession } from '../state/store';
import { Button, Dialog } from '../ui';

export function QtySubmitDialog({
  po,
  session,
  issue,
  onClose,
  onEdit,
}: {
  po: PoRow;
  session: PoSession;
  issue: 'BELOW' | 'ABOVE' | 'IMPOSSIBLE';
  onClose: () => void;
  onEdit: () => void;
}) {
  const t = totals(session.state, po);
  const n = formatCount(t.qtyDefect);
  const q = formatCount(t.qtyInspection);
  const limit = `${po.partial ? 'partial' : 'Qty Order'} ${formatCount(po.partial?.qty ?? po.orderQty)} pasang`;
  const title =
    issue === 'IMPOSSIBLE'
      ? 'Defect melebihi jumlah pasang'
      : issue === 'BELOW'
        ? 'QTY INSPECTION kurang'
        : 'QTY INSPECTION terlalu besar';
  // PSI lv.2 taps Qty Inspection: it can only be too large after the partial was lowered (ADR-021).
  const tapped = session.state.mode === 'TAPPED';
  const message =
    issue === 'IMPOSSIBLE'
      ? `${n} defect tercatat, melebihi ${limit}. Perbaiki defect (UNDO)${po.partial ? ' atau partial' : ''}.`
      : issue === 'BELOW'
        ? `QTY INSPECTION ${q} pasang, tetapi ${n} defect sudah tercatat. Minimal ${n} pasang.`
        : tapped
          ? `QTY INSPECTION ${q} pasang melebihi ${limit}. Ubah partial.`
          : `QTY INSPECTION ${q} pasang melebihi ${limit}.`;
  const edits = issue !== 'IMPOSSIBLE' && !tapped;
  return (
    <Overlay>
      <Dialog title={title} role="alertdialog" onClose={false}>
        <p className="dialog__text">{message}</p>
        <div className="dialog__actions">
          <Button variant="primary" onClick={edits ? onEdit : onClose}>
            {edits ? 'Ubah QTY INSPECTION' : 'Mengerti'}
          </Button>
        </div>
      </Dialog>
    </Overlay>
  );
}
