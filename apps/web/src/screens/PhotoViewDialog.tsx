/**
 * S7b View a photo (doc 05 §12.2): the defect with its classification, the photo, GANTI FOTO (replaces it,
 * AC-10.5) and HAPUS (removes it without asking, U11).
 */
import { Overlay } from '../app/Overlay';
import type { PhotoRow } from '../db/schema';
import { usePhotoUrl } from '../photos/usePhotoUrl';
import { Button, Chip, Dialog, type Classification } from '../ui';

export interface PhotoViewDialogProps {
  photo: PhotoRow;
  name: string;
  classification: Classification;
  onReplace: () => void;
  onRemove: () => void;
  onClose: () => void;
}

export function PhotoViewDialog({
  photo,
  name,
  classification,
  onReplace,
  onRemove,
  onClose,
}: PhotoViewDialogProps) {
  const src = usePhotoUrl(photo.blob);
  return (
    <Overlay onDismiss={onClose}>
      <Dialog wide title="Foto defect" onClose={onClose} className="photo-view">
        <p className="dialog__text photo-view__defect">
          <Chip tone={classification} /> {name}
        </p>
        {src ? <img className="photo-view__img" src={src} alt={`Foto defect ${name}`} /> : null}
        <div className="dialog__actions">
          <Button icon="camera" onClick={onReplace}>
            GANTI FOTO
          </Button>
          <Button variant="danger" onClick={onRemove}>
            HAPUS
          </Button>
        </div>
      </Dialog>
    </Overlay>
  );
}
