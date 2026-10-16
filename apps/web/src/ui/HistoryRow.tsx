import { Chip, type Classification } from './Chip';
import { cx } from './cx';

export interface HistoryRowProps {
  head?: boolean;
  no?: number;
  name?: string;
  /** "Area › Sub-area · Family · TYPE" */
  path?: string;
  classification?: Classification;
  qty?: number;
  flash?: boolean;
  className?: string;
}

export function HistoryRow({
  head,
  no,
  name,
  path,
  classification,
  qty,
  flash,
  className,
}: HistoryRowProps) {
  if (head) {
    return (
      <div className={cx('m100-hist', 'm100-hist--head', className)}>
        <div>No</div>
        <div>Defect name</div>
        <div>Kelas</div>
        <div style={{ textAlign: 'right' }}>Qty</div>
      </div>
    );
  }
  return (
    <div className={cx('m100-hist', flash && 'm100-flash', className)}>
      <div className="m100-hist__no">{no}.</div>
      <div className="m100-hist__nm">
        {name}
        {path ? <small>{path}</small> : null}
      </div>
      <div>{classification != null ? <Chip tone={classification} /> : null}</div>
      <div className="m100-hist__q">{qty}</div>
    </div>
  );
}
