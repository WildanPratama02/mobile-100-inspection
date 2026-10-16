# Chip

A small uppercase label for a fixed category: defect classification, inspection type, user level.

**Use**
- `minor`, `major`, `critical` (or 1, 2, 3) wherever a defect appears: Top 5, drill-down defect rows, history. The word is the meaning; the colour only supports it.
- `rework` and `bgrade` (blue) for the inspection type that is running, in the context strip above the list.
- `role` (white, grey border) for the PSI level next to the name; `neutral` for codes such as the cell.

**Consumer provides:** `tone`; `children` only for `role` and `neutral` (classification and mode chips write their own word).

**Don't** use a chip as a button, or invent new tones for status (use `OutboxItem` or `Notice`).
