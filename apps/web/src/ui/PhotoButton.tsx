import { cx } from './cx';
import { Icon } from './Icon';

export interface PhotoButtonProps {
  state?: 'add' | 'required' | 'attached';
  src?: string;
  label?: string;
  onClick?: () => void;
  className?: string;
}

export function PhotoButton({ state = 'add', src, label, onClick, className }: PhotoButtonProps) {
  if (state === 'attached') {
    return (
      <button
        type="button"
        className={cx('m100-photo', 'm100-photo--attached', className)}
        onClick={onClick}
        aria-label={label ?? 'Lihat foto'}
      >
        {src ? <img src={src} alt="" /> : null}
        <i>
          <Icon name="check" />
        </i>
      </button>
    );
  }
  return (
    <button
      type="button"
      className={cx('m100-photo', state === 'required' && 'm100-photo--required', className)}
      onClick={onClick}
      aria-label={state === 'required' ? 'Foto wajib' : 'Tambah foto'}
    >
      <Icon name="camera" />
      <span>Foto</span>
    </button>
  );
}
