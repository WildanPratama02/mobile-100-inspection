# NumberPad

An in-app digit pad with a large readout. The tablet keyboard never opens.

**Use** for the partial quantity on Add PO: `max` = Qty Order, `unit` "PASANG". Digits 0–9, HAPUS clears all, the back key removes one digit.

**Consumer provides:** `value` (digit string, no separators), `max`, `unit`, `label`, `placeholder`, `hint`, `onChange(digits)`. The readout shows id-ID thousands dots (1.200). A value below 1 or above `max` turns the readout border `danger` and shows "Minimal 1 pasang" or "Maksimum 10.002 pasang"; the consumer disables its confirm button in that case and keeps the reason visible. Leading zeros are dropped; at most 9 digits.

**Do / don't**
- Do place it inside the Add PO dialog under the Stepper; keys are 58px high.
- Don't add a decimal or sign key.
