/**
 * S7a photo menu (doc 05 §12.1, ADR-023): the photo button of an ALL DEFECT row and GANTI FOTO open it. "Ambil
 * Foto" opens the tablet camera, "Pilih dari Galeri" the gallery or file picker; both hand the file to the same
 * resize pipeline. BATAL, the close button, the scrim and Escape change nothing. The consumer owns the two file
 * inputs: a picker only opens from the tap itself, so `onCamera` / `onGallery` must click the input synchronously.
 */
import { Overlay } from '../app/Overlay';
import { Button, Chip, Dialog, type Classification } from '../ui';

export interface PhotoSourceDialogProps {
  name: string;
  classification: Classification;
  onCamera: () => void;
  onGallery: () => void;
  onClose: () => void;
}

export function PhotoSourceDialog({
  name,
  classification,
  onCamera,
  onGallery,
  onClose,
}: PhotoSourceDialogProps) {
  return (
    <Overlay onDismiss={onClose}>
      <Dialog title="Foto defect" onClose={onClose} className="photo-source">
        <p className="dialog__text photo-view__defect">
          <Chip tone={classification} /> {name}
        </p>
        <div className="photo-source__choices">
          <Button icon="camera" block onClick={onCamera}>
            Ambil Foto
          </Button>
          <Button block onClick={onGallery}>
            Pilih dari Galeri
          </Button>
        </div>
        <div className="dialog__actions">
          <Button onClick={onClose}>BATAL</Button>
        </div>
      </Dialog>
    </Overlay>
  );
}
