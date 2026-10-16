# CheckboxRow

A full-width row with a large checkbox and a label, for one yes/no choice in a dialog.

**Use** for PO PARTIAL on Add PO ("PO PARTIAL", sub "Kirim sebagian dari Qty Order"). Checking it reveals the Stepper and NumberPad below it.

**Consumer provides:** `checked`, `label`, `sub`, `onChange(checked)`, `disabled`. The whole row is the tap target (min `row-min`); the box is 32px. Checked = accent box with a check mark and an accent border.

**Do / don't**
- Do keep the label to a few uppercase words; put explanation in `sub`.
- Don't use for a choice with more than two states (use `SelectField`).
- State is shown by the check mark and the border, never by colour alone.
