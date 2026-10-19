/**
 * S5 Partial (doc 05 §10, FR-03.6): change or remove the selected PO's PO PARTIAL before the next SUBMIT PO.
 * Also opened empty from the "PO PARTIAL" button when the PO has none yet (U9).
 */
import { useState } from 'react';
import { Overlay } from '../app/Overlay';
import type { PoRow } from '../db/schema';
import { useAppStore } from '../state/store';
import { Button, Dialog } from '../ui';
import { draftOf, partialOf } from './partial';
import { PartialFields } from './PartialFields';
import './screens.css';

export interface PartialDialogProps {
  po: PoRow;
  onClose: () => void;
}

export function PartialDialog({ po, onClose }: PartialDialogProps) {
  const setPartial = useAppStore((s) => s.setPartial);
  const [draft, setDraft] = useState(() => draftOf(po.partial));
  const [busy, setBusy] = useState(false);
  const partial = partialOf(draft, po.orderQty);

  async function save() {
    if (partial === undefined) return;
    setBusy(true);
    try {
      await setPartial(po.po, partial);
      onClose();
    } catch (error) {
      console.error(error);
      setBusy(false);
    }
  }

  return (
    <Overlay onDismiss={onClose}>
      <Dialog title="PO Partial" onClose={onClose} className="partial-dialog">
        <PartialFields draft={draft} orderQty={po.orderQty} onChange={setDraft} />
        <div className="dialog__actions">
          <Button onClick={onClose}>BATAL</Button>
          <Button
            variant="primary"
            disabled={partial === undefined || busy}
            onClick={() => void save()}
          >
            SIMPAN
          </Button>
        </div>
      </Dialog>
    </Overlay>
  );
}
