import { Logo } from '../app/Logo';
import { Button, Notice } from '../ui';
import './screens.css';

export interface StartScreenProps {
  /** `true` when nothing could be loaded and nothing is cached (AC-01.4). */
  failed: boolean;
  /** The API's `code` for the failure, if it answered. */
  problem?: string | null;
  onRetry: () => void;
}

/** S1 on a first launch: master data is loading, or it failed with nothing cached (doc 05 §6). */
export function StartScreen({ failed, problem = null, onRetry }: StartScreenProps) {
  return (
    <main className="app-screen start">
      <div className="start__box">
        <Logo placement="start" />
        {failed ? (
          <>
            <Notice tone="danger">
              {problem === 'DEVICE_KEY_INVALID'
                ? // A revoked or wrong key (doc 05 §15).
                  'Tablet belum terdaftar, hubungi admin'
                : 'Data awal belum bisa diunduh. Periksa Wi-Fi, lalu tekan RETRY.'}
            </Notice>
            <Button variant="primary" size="lg" block onClick={onRetry}>
              RETRY
            </Button>
          </>
        ) : (
          <p className="start__text">Menyiapkan data…</p>
        )}
      </div>
    </main>
  );
}
