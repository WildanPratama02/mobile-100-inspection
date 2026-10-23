import type { ReactNode } from 'react';
import { Button } from '@m100/ui';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Numbers are right-aligned. */
  numeric?: boolean;
  mono?: boolean;
}

export interface DataTableProps<T> {
  label: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  /** Greys out inactive rows. */
  muted?: (row: T) => boolean;
  /** Mouse convenience: the row's first cell holds a link or button for the keyboard. */
  onRowClick?: (row: T) => void;
  selected?: (row: T) => boolean;
}

/** A plain `<table>` that scrolls sideways inside its frame, never the page. */
export function DataTable<T>({
  label,
  columns,
  rows,
  rowKey,
  muted,
  onRowClick,
  selected,
}: DataTableProps<T>) {
  return (
    <div className="adm-table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table className="adm-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.numeric ? 'adm-num' : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={[
                muted?.(row) ? 'adm-row--muted' : '',
                onRowClick ? 'adm-row--link' : '',
                selected?.(row) ? 'adm-row--selected' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-selected={selected ? selected(row) : undefined}
              onClick={(event) => {
                // A click on a control inside the row does its own thing.
                if ((event.target as HTMLElement).closest('a, button, input, select')) return;
                onRowClick?.(row);
              }}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={[c.numeric ? 'adm-num' : '', c.mono ? 'adm-mono' : '']
                    .filter(Boolean)
                    .join(' ')}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface PagerProps {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}

/** 50 per page with the total (doc 05 §20.3). */
export function Pager({ page, pageSize, total, onPage }: PagerProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="adm-pager" aria-label="Halaman">
      <span>
        Halaman {page} dari {pages}
      </span>
      <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        SEBELUMNYA
      </Button>
      <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        BERIKUTNYA
      </Button>
    </nav>
  );
}
