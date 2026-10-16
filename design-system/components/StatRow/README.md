# StatRow

One label–value line in the Home results box.

**Use** for the seven results in this order: Qty PO Order, Qty Inspection, Qty Defect, Qty A-Grade, Qty B-Grade, Defect Rate, Pass Rate (RFT), on `panel`.

**Consumer provides:** `label`, `value` already formatted in Indonesian style ("2.400", "22,0"), `unit` ("%"), `tone="bad"` when Defect Rate is above the target. A `null` value shows "—".
