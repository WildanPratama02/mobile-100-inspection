/**
 * "Foto belum lengkap" (doc 05 §8.5, §13.1): PSI lv.2 tried to export, or to submit, while a defect of ALL DEFECT
 * has no photo (BR-04, ADR-022). It must be answered; `Lengkapi foto` closes it and nothing is made.
 */
import { Overlay } from '../app/Overlay';
import { Button, Dialog } from '../ui';

export interface MissingPhotosDialogProps {
  /** Every defect name without a photo, exactly as in the mapping, in ranking order. */
  names: readonly string[];
  onClose: () => void;
}

export function MissingPhotosDialog({ names, onClose }: MissingPhotosDialogProps) {
  return (
    <Overlay>
      <Dialog title="Foto belum lengkap" role="alertdialog" onClose={false}>
        <p className="dialog__text">
          PSI lv.2 wajib menambahkan foto pada setiap defect. Belum ada foto untuk:
        </p>
        <ul className="dialog__list">
          {names.map((name, i) => (
            <li key={`${i}-${name}`}>{name}</li>
          ))}
        </ul>
        <div className="dialog__actions">
          <Button variant="primary" onClick={onClose}>
            Lengkapi foto
          </Button>
        </div>
      </Dialog>
    </Overlay>
  );
}
