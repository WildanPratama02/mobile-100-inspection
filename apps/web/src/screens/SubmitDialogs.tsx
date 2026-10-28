/**
 * S8 SUBMIT PO (doc 05 §13): the blocking check dialogs of step 1 and the confirmation of step 2. The photo
 * check uses `MissingPhotosDialog`. Each dialog only reads; KIRIM hands over to the store, which seals.
 */
import { formatCount, formatPartial, formatRate, takesPhotos, totals } from '@m100/shared';
import { Overlay } from '../app/Overlay';
import type { Auth, PoRow } from '../db/schema';
import { photosToSubmit, type PoSession } from '../state/store';
import { Button, Dialog, StatRow } from '../ui';

/** "Inspeksi masih berjalan" (must answer): `Ke ADD DEFECT` opens S6. */
export function SubmitActiveDialog({ onAddDefect }: { onAddDefect: () => void }) {
  return (
    <Overlay>
      <Dialog title="Inspeksi masih berjalan" role="alertdialog" onClose={false}>
        <p className="dialog__text">Selesaikan inspeksi dulu (END INSPECTION).</p>
        <div className="dialog__actions">
          <Button variant="primary" onClick={onAddDefect}>
            Ke ADD DEFECT
          </Button>
        </div>
      </Dialog>
    </Overlay>
  );
}

/** Qty Inspection is empty: the action opens the quantity editor. */
export function SubmitEmptyDialog({ onClose }: { onClose: () => void }) {
  return (
    <Overlay>
      <Dialog title="QTY INSPECTION belum diisi" role="alertdialog" onClose={false}>
        <p className="dialog__text">Isi jumlah pasang yang diinspeksi sebelum SUBMIT PO.</p>
        <div className="dialog__actions">
          <Button variant="primary" onClick={onClose}>
            Isi QTY INSPECTION
          </Button>
        </div>
      </Dialog>
    </Overlay>
  );
}

export interface SubmitConfirmDialogProps {
  po: PoRow;
  session: PoSession;
  level: Auth['level'];
  onCancel: () => void;
  onSend: () => void;
}

/** "Submit PO" (doc 05 §13.2): the summary of what KIRIM seals. Closable; BATAL changes nothing. */
export function SubmitConfirmDialog({
  po,
  session,
  level,
  onCancel,
  onSend,
}: SubmitConfirmDialogProps) {
  const t = totals(session.state, po);
  return (
    <Overlay onDismiss={onCancel}>
      <Dialog title="Submit PO" onClose={onCancel}>
        <div className="submit__summary">
          <StatRow label="PO" value={po.po} className="submit__po" />
          {po.partial ? (
            <StatRow label="Partial" value={formatPartial(po.partial, po.orderQty)} />
          ) : null}
          <StatRow label="Qty Inspection" value={formatCount(t.qtyInspection)} />
          <StatRow label="Qty Defect" value={formatCount(t.qtyDefect)} />
          <StatRow label="Qty A-Grade" value={formatCount(t.qtyAGrade ?? 0)} />
          <StatRow label="Qty B-Grade" value={formatCount(t.qtyBGrade)} />
          <StatRow label="Defect Rate" value={formatRate(t.defectRate ?? 0)} />
          <StatRow label="Pass Rate (RFT)" value={formatRate(t.passRate ?? 0)} />
          {takesPhotos(level) ? (
            <StatRow label="Foto" value={formatCount(photosToSubmit(level, session).length)} />
          ) : null}
        </div>
        <div className="dialog__actions">
          <Button onClick={onCancel}>BATAL</Button>
          <Button variant="primary" onClick={onSend}>
            KIRIM
          </Button>
        </div>
      </Dialog>
    </Overlay>
  );
}
