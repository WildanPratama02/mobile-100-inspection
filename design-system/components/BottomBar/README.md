# BottomBar

A row of equal, large rounded buttons along the bottom of a pane: BACK / HOME / UNDO on the defect screen.

**Use**
- Defect screen: always BACK, HOME, UNDO in that order, with their icons.
- UNDO is `disabled` (grey) when there is nothing it can undo; never hide it.
- In portrait the consumer makes the bar sticky to the bottom edge and adds the safe-area inset.

**Consumer provides:** `items` (label, icon, onClick, disabled), optional `label` for the nav landmark.

**Don't** put more than four items in it or use it for the ADD DEFECT bar (that is a `Button` with `size="lg"` and `block`).
