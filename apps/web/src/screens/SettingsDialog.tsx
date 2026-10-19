/**
 * S9 gear menu (doc 05 §14, FR-02): the account and LOGOUT. The Pengiriman list comes with the outbox
 * (T1.7) and the master-data time with T2.6.
 */
import { useState } from 'react';
import { Logo } from '../app/Logo';
import { Overlay } from '../app/Overlay';
import type { Auth } from '../db/schema';
import { unsubmittedCount, useAppStore } from '../state/store';
import { Button, Chip, Dialog } from '../ui';
import './screens.css';

export interface SettingsDialogProps {
  auth: Auth;
  onClose: () => void;
}

export function SettingsDialog({ auth, onClose }: SettingsDialogProps) {
  const logout = useAppStore((s) => s.logout);
  const pending = useAppStore(unsubmittedCount);
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    // Blocking: must be answered (AC-02.2). It replaces the menu; dialogs never stack.
    return (
      <Overlay>
        <Dialog title="Keluar?" role="alertdialog" onClose={false}>
          <p className="settings__text">
            {pending} PO belum disubmit. Data tetap tersimpan di tablet ini untuk {auth.username}.
          </p>
          <div className="settings__actions">
            <Button onClick={onClose}>BATAL</Button>
            <Button variant="danger" onClick={() => void logout()}>
              LOGOUT
            </Button>
          </div>
        </Dialog>
      </Overlay>
    );
  }

  return (
    <Overlay onDismiss={onClose}>
      <Dialog title="Pengaturan" onClose={onClose}>
        <section className="settings__account" aria-label="Akun">
          <Logo placement="menu" />
          <div>
            <div className="settings__name">
              {auth.username} <Chip tone="role">{auth.level}</Chip>
            </div>
            <div className="settings__cell">Factory/Cell {auth.cell}</div>
          </div>
        </section>
        <Button
          variant="danger"
          block
          onClick={() => (pending > 0 ? setConfirming(true) : void logout())}
        >
          LOGOUT
        </Button>
      </Dialog>
    </Overlay>
  );
}
