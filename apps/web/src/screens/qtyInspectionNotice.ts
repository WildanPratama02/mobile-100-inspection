import { formatCount, type QtyInspectionIssue } from '@m100/shared';
import type { PoRow } from '../db/schema';

export function qtyNotice(kind: QtyInspectionIssue['kind'], qtyDefect: number, po: PoRow): string {
  const n = formatCount(qtyDefect);
  const limit = `${po.partial ? 'partial' : 'Qty Order'} ${formatCount(po.partial?.qty ?? po.orderQty)} pasang`;
  if (kind === 'EMPTY')
    return 'Isi QTY INSPECTION untuk menghitung A-Grade, Defect Rate, dan Pass Rate.';
  if (kind === 'IMPOSSIBLE')
    return `${n} defect tercatat, melebihi ${limit}. Perbaiki defect${po.partial ? ' atau partial' : ''} sebelum SUBMIT PO.`;
  if (kind === 'BELOW')
    return `QTY INSPECTION kurang dari ${n} defect yang tercatat. Ubah sebelum SUBMIT PO.`;
  return `QTY INSPECTION melebihi ${limit}. Ubah sebelum SUBMIT PO.`;
}
