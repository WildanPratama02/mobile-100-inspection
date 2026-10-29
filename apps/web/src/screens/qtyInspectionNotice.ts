import { formatCount, type CountingMode, type QtyInspectionIssue } from '@m100/shared';
import type { PoRow } from '../db/schema';

/** `mode`: PSI lv.2 counts Qty Inspection with taps, so only a lowered partial makes it too large (ADR-021). */
export function qtyNotice(
  kind: QtyInspectionIssue['kind'],
  qtyDefect: number,
  po: PoRow,
  mode: CountingMode = 'ENTERED',
): string {
  const n = formatCount(qtyDefect);
  const limit = `${po.partial ? 'partial' : 'Qty Order'} ${formatCount(po.partial?.qty ?? po.orderQty)} pasang`;
  if (mode === 'TAPPED') return `QTY INSPECTION melebihi ${limit}. Ubah partial sebelum SUBMIT PO.`;
  if (kind === 'EMPTY')
    return 'Isi QTY INSPECTION untuk menghitung A-Grade, Defect Rate, dan Pass Rate.';
  if (kind === 'IMPOSSIBLE')
    return `${n} defect tercatat, melebihi ${limit}. Perbaiki defect${po.partial ? ' atau partial' : ''} sebelum SUBMIT PO.`;
  if (kind === 'BELOW')
    return `QTY INSPECTION kurang dari ${n} defect yang tercatat. Ubah sebelum SUBMIT PO.`;
  return `QTY INSPECTION melebihi ${limit}. Ubah sebelum SUBMIT PO.`;
}
