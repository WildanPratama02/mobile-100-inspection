/**
 * S0 Setup (doc 05 §5, doc 03 §4.9): the administrator opens `/setup#k=<device key>` once per tablet. The page
 * stores the key, removes the fragment from the address, and checks the key with `GET /system/status`. No field,
 * no keyboard; never a PSI path.
 */
import { useEffect, useState } from 'react';
import { useDataSources } from '../app/dataSources';
import { Logo } from '../app/Logo';
import { keyFromHash, SETUP_PATH } from '../app/setupLink';
import { ApiError } from '../data/sources';
import { useAppStore, useAppStoreApi } from '../state/store';
import { Button, Icon, Notice } from '../ui';
import './screens.css';

type Check = 'checking' | 'registered' | 'invalid' | 'unreachable';

export function SetupScreen() {
  const store = useAppStoreApi();
  const { system } = useDataSources();
  const hydrated = useAppStore((s) => s.status === 'ready');
  const deviceKey = useAppStore((s) => s.deviceKey);
  const [linkKey] = useState(() => keyFromHash(window.location.hash));
  const [saved, setSaved] = useState(linkKey === null);
  const [attempt, setAttempt] = useState(0);
  const [check, setCheck] = useState<Check>('checking');
  // Opened without a key and none stored (doc 05 §5, last row).
  const missing = saved && hydrated && !deviceKey;

  useEffect(() => {
    // Another setup link opened while this page is still open only changes the fragment: start over with it.
    const restart = () => window.location.reload();
    window.addEventListener('hashchange', restart);
    return () => window.removeEventListener('hashchange', restart);
  }, []);

  useEffect(() => {
    if (!linkKey) return;
    store
      .getState()
      .saveDeviceKey(linkKey)
      .catch((error: unknown) => console.error(error))
      .finally(() => {
        // The key must not stay in the address bar; a fragment never reaches the server (doc 03 §4.9).
        window.history.replaceState(null, '', SETUP_PATH);
        setSaved(true);
      });
  }, [store, linkKey]);

  useEffect(() => {
    if (!saved || !hydrated || !deviceKey) return;
    let current = true;
    system.check().then(
      () => {
        if (current) setCheck('registered');
      },
      (error: unknown) => {
        if (!current) return;
        console.error(error);
        setCheck(
          error instanceof ApiError && error.code === 'DEVICE_KEY_INVALID'
            ? 'invalid'
            : 'unreachable',
        );
      },
    );
    return () => {
      current = false;
    };
  }, [saved, hydrated, deviceKey, system, attempt]);

  return (
    <main className="app-screen start">
      <div className="start__box">
        <Logo placement="start" />
        {missing ? (
          <NotRegisteredNotice />
        ) : check === 'checking' ? (
          <p className="start__text">Memeriksa tablet…</p>
        ) : check === 'registered' ? (
          <>
            <Icon name="check" size={48} className="setup__check" />
            <h1 className="start__text">Tablet terdaftar</h1>
            <p className="setup__body">
              Pasang aplikasi ini dari menu Chrome (Install app), lalu buka dari layar utama.
            </p>
            <Button variant="primary" size="lg" block onClick={() => window.location.assign('/')}>
              Lanjut
            </Button>
          </>
        ) : check === 'invalid' ? (
          <Notice tone="danger">
            Kunci tablet tidak valid. Minta tautan setup yang baru dari admin.
          </Notice>
        ) : (
          // unreachable
          <>
            <Notice tone="warning">
              Tidak bisa terhubung ke server. Periksa Wi-Fi, lalu coba lagi.
            </Notice>
            <Button
              variant="primary"
              size="lg"
              block
              onClick={() => {
                setCheck('checking');
                setAttempt((n) => n + 1);
              }}
            >
              Coba lagi
            </Button>
          </>
        )}
      </div>
    </main>
  );
}

function NotRegisteredNotice() {
  return <Notice tone="warning">Tablet ini belum terdaftar. Buka tautan setup dari admin.</Notice>;
}

/** The installed app started without a stored key: this message only, no Login (doc 05 §5 "Not a PSI path"). */
export function NotRegisteredScreen() {
  return (
    <main className="app-screen start">
      <div className="start__box">
        <Logo placement="start" />
        <NotRegisteredNotice />
      </div>
    </main>
  );
}
