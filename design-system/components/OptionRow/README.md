# OptionRow

A full-width row in the drill-down list on the defect screen: a sub-area or family to open (`nav`), or a defect to record (`defect`).

**Use**
- `nav` rows show the name in caps, an optional sub-line ("37 defect") and a count, with a chevron.
- `defect` rows show the defect name exactly as in `DEFECT_LIST`, its classification chip and, once tapped in the active inspection, the tap count in an accent box.
- Set `flash` for one render after a tap to play the accent flash.
- Rows are `disabled` while no inspection is active.

**Consumer provides:** `kind`, `title`, `sub`, `count`, `classification`, `qty`, `flash`, `disabled`, `onClick`.
