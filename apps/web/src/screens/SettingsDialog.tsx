/**
 * S9 gear menu (doc 05 §14, FR-02): the account, the PSI's own submissions (AC-11.3, U14), when master data was
 * last updated (AC-13.4) and LOGOUT.
 */
import { useEffect, useState } from 'react';
import { formatDayTime, formatTime } from '@m100/shared';
import { Logo } from '../app/Logo';
import { Overlay } from '../app/Overlay';
import type { Auth, CorrectionRow, OutboxRow } from '../db/schema';
import { useCorrectionChecker } from '../outbox/useOutboxSender';
import { unsubmittedCount, useAppStore } from '../state/store';
import { Button, Chip, Dialog, OutboxItem } from '../ui';
import './screens.css';

export interface SettingsDialogProps {
  auth: Auth;
  onClose: () => void;
}

export function SettingsDialog({ auth, onClose }: SettingsDialogProps) {
  const logout = useAppStore((s) => s.logout);
  const pending = useAppStore(unsubmittedCount);
  const [confirming, setConfirming] = useState(false);
  const checker = useCorrectionChecker();
  // Opening Pengaturan looks for admin corrections when online (doc 05 §14, ADR-023).
  useEffect(() => {
    if (navigator.onLine) void checker?.check();
  }, [checker]);

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
        <Outbox />
        <MasterDataTime />
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

/**
 * Pengiriman (doc 05 §14): one item per submission of this PSI, newest first, with its status in words, the last
 * attempt of a Menunggu item once there was one, and the reason of a Gagal item (AC-11.3).
 */
function Outbox() {
  const outbox = useAppStore((s) => s.outbox);
  const corrections = useAppStore((s) => s.corrections);
  return (
    <section className="settings__outbox" aria-label="Pengiriman">
      <h4 className="settings__heading">Pengiriman</h4>
      {outbox.length === 0 ? (
        <p className="settings__text">Tidak ada pengiriman.</p>
      ) : (
        <ul className="settings__list">
          {outbox.map((item) => (
            <li key={item.submissionUuid}>
              <OutboxEntry item={item} correction={corrections[item.submissionUuid]} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The API's `detail` and the messages of its `errors` list (doc 04 §5). */
function reasonOf(item: OutboxRow): string | undefined {
  const parts = [item.problem, ...(item.problemErrors ?? [])].filter(
    (p): p is string => typeof p === 'string' && p !== '',
  );
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function OutboxEntry({ item, correction }: { item: OutboxRow; correction?: CorrectionRow }) {
  return (
    <>
      <OutboxItem
        po={item.po}
        time={formatTime(item.sealedAt)}
        status={item.state}
        reason={item.state === 'failed' ? reasonOf(item) : undefined}
        detail={
          item.state === 'waiting' && item.lastAttemptAt
            ? `Dicoba terakhir ${formatTime(item.lastAttemptAt)}`
            : undefined
        }
      />
      {item.state === 'failed' ? (
        <small className="settings__hint">Hubungi admin dengan nomor PO ini.</small>
      ) : null}
      {item.state === 'sent' && correction ? (
        <p className="settings__corrected">
          <Chip tone="neutral">Dikoreksi admin</Chip>{' '}
          <span>
            Dikoreksi admin {formatDayTime(correction.correctedAt)} · {correction.reason}
          </span>
        </p>
      ) : null}
    </>
  );
}

/** Data (doc 05 §14): when the API last confirmed the tablet's master data current (AC-13.4). */
function MasterDataTime() {
  const checkedAt = useAppStore((s) => s.masterDataCheckedAt);
  // Logging in needs master data, so a logged-in PSI always has a time; nothing is shown without one.
  if (!checkedAt) return null;
  return (
    <section className="settings__data" aria-label="Data">
      <h4 className="settings__heading">Data</h4>
      <p className="settings__text">Data master diperbarui {formatDayTime(checkedAt)}</p>
    </section>
  );
}
