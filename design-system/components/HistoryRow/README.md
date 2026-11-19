# HistoryRow

One line of the session history under the drill-down: number, defect, where it was found, classification and quantity.

**Use** one row per area + sub-area + defect + inspection type (the same grain as `M100_DEFECT_DETAIL`), with a `head` row on top. Flash the row that just changed and scroll it into view.

**Consumer provides:** `no`, `name`, `path` ("Area › Sub-area · Family · TYPE"), `classification`, `qty`, `flash`; or `head`.

Optional `onClick` renders the row as a button with the accessible label "Ubah {name}", at least `--tap-min` (44px) high, `--accent-soft` while pressed. Used for the NO DEFECT row of PSI lv.2, which opens the NO DEFECT dialog (doc 05 §11.1, §11.6, ADR-023).
