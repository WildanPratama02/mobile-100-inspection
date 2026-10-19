/** PO PARTIAL as the PSI enters it in S4 and S5 (doc 05 §9–10, ADR-013). */
import type { PoPartial } from '@m100/shared';

/** What the PSI has entered so far; `digits` is the NumberPad's digit string. */
export interface PartialDraft {
  on: boolean;
  number: number;
  digits: string;
}

export const NO_PARTIAL: PartialDraft = { on: false, number: 1, digits: '' };

export function draftOf(partial: PoPartial | null): PartialDraft {
  return partial ? { on: true, number: partial.number, digits: String(partial.qty) } : NO_PARTIAL;
}

/**
 * The partial to store: `null` when PO PARTIAL is off, `undefined` while the quantity is not a whole number
 * from 1 to Qty Order (AC-03.6), so the confirm button stays disabled.
 */
export function partialOf(draft: PartialDraft, orderQty: number): PoPartial | null | undefined {
  if (!draft.on) return null;
  if (!/^\d+$/.test(draft.digits)) return undefined;
  const qty = Number(draft.digits);
  return qty >= 1 && qty <= orderQty ? { number: draft.number, qty } : undefined;
}
