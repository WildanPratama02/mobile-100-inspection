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
  /** Renders the row as a button with the accessible label "Ubah {name}" (doc 05 §11.1, ADR-023). */
  onClick?: () => void;
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
  onClick,
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
  const Tag = onClick ? 'button' : 'div';
  // A button may only hold phrasing content; as grid items the spans lay out like the divs.
  const Cell = onClick ? 'span' : 'div';
  return (
    <Tag
      className={cx('m100-hist', flash && 'm100-flash', className)}
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-label={onClick ? `Ubah ${name ?? ''}`.trim() : undefined}
    >
      <Cell className="m100-hist__no">{no}.</Cell>
      <Cell className="m100-hist__nm">
        {name}
        {path ? <small>{path}</small> : null}
      </Cell>
      <Cell>{classification != null ? <Chip tone={classification} /> : null}</Cell>
      <Cell className="m100-hist__q">{qty}</Cell>
    </Tag>
  );
}
