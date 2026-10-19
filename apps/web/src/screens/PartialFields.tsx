/**
 * PO PARTIAL inputs shared by S4 Add PO and S5 Partial (doc 05 §9.1 steps 3–4, §10; ADR-013): the checkbox,
 * then the partial number (Stepper) and the quantity in pairs (NumberPad, never the device keyboard).
 */
import { formatCount } from '@m100/shared';
import { CheckboxRow, NumberPad, Stepper } from '../ui';
import { NO_PARTIAL, type PartialDraft } from './partial';
import './screens.css';

export interface PartialFieldsProps {
  draft: PartialDraft;
  orderQty: number;
  /** Until a PO is chosen (doc 05 §9.1 step 3). */
  disabled?: boolean;
  onChange: (draft: PartialDraft) => void;
}

export function PartialFields({ draft, orderQty, disabled, onChange }: PartialFieldsProps) {
  return (
    <>
      <CheckboxRow
        label="PO PARTIAL"
        sub="Kirim sebagian dari Qty Order"
        checked={draft.on}
        disabled={disabled}
        // Unticking discards the number and the quantity (doc 05 §9.2).
        onChange={(on) => onChange(on ? { ...NO_PARTIAL, on } : NO_PARTIAL)}
      />
      {draft.on ? (
        <div className="partial__inputs">
          <Stepper
            label="Partial ke"
            value={draft.number}
            min={1}
            max={99}
            format={(v) => `P${v}`}
            onChange={(number) => onChange({ ...draft, number })}
          />
          <NumberPad
            label="Qty partial"
            unit="PASANG"
            value={draft.digits}
            max={orderQty}
            hint={`Masukkan jumlah pasang, 1 sampai ${formatCount(orderQty)}`}
            onChange={(digits) => onChange({ ...draft, digits })}
          />
        </div>
      ) : null}
    </>
  );
}
