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

/** PSI lv.2 has tapped no pair yet (ADR-021): `Ke ADD DEFECT` opens S6, where NO DEFECT is. */
export function SubmitNoPairsDialog({ onAddDefect }: { onAddDefect: () => void }) {
  return (
    <Overlay>
      <Dialog title="Belum ada pasang diinspeksi" role="alertdialog" onClose={false}>
        <p className="dialog__text">
          Tekan NO DEFECT untuk pasang tanpa defect, atau REWORK / B-GRADE untuk pasang dengan
          defect, sebelum SUBMIT PO.
        </p>
        <div className="dialog__actions">
          <Button variant="primary" onClick={onAddDefect}>
            Ke ADD DEFECT
          </Button>
        </div>
      </Dialog>
    </Overlay>
  );
}

/**
 * REWORK AND APPROVED is above INSPECTION REWORK QTY after UNDO (BR-11): the action opens S5c, also at 0 rework,
 * so the PSI can save 0 or empty.
 */
export function SubmitReworkApprovedDialog({ onEdit }: { onEdit: () => void }) {
  return (
    <Overlay>
      <Dialog title="REWORK AND APPROVED tidak valid" role="alertdialog" onClose={false}>
        <p className="dialog__text">
          REWORK AND APPROVED melebihi INSPECTION REWORK QTY. Ubah angkanya sebelum SUBMIT PO.
        </p>
        <div className="dialog__actions">
          <Button variant="primary" onClick={onEdit}>
            Ubah REWORK AND APPROVED
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
          <StatRow label="INSPECTION REWORK QTY" value={formatCount(t.inspectionReworkQty)} />
          {/* Empty is sealed as 0 (BR-11). */}
          <StatRow label="REWORK AND APPROVED" value={formatCount(t.reworkApproved ?? 0)} />
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
