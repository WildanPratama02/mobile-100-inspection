import { cx } from './cx';

export interface OutboxItemProps {
  po: string;
  time?: string;
  status: 'waiting' | 'sending' | 'sent' | 'failed';
  reason?: string;
  detail?: string;
  className?: string;
}

const STATUS: Record<OutboxItemProps['status'], string> = {
  waiting: 'Menunggu',
  sending: 'Mengirim',
  sent: 'Terkirim',
  failed: 'Gagal',
};

export function OutboxItem({ po, time, status, reason, detail, className }: OutboxItemProps) {
  const note = reason || detail;
  return (
    <div className={cx('m100-outbox', className)}>
      <span>
        <span className="m100-po-no">{po}</span>
        {time ? `  ·  ${time}` : ''}
      </span>
      <span className={`m100-status m100-status--${status}`}>{STATUS[status]}</span>
      {note ? <small>{note}</small> : null}
    </div>
  );
}
