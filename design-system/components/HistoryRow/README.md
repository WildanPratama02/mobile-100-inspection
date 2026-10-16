# HistoryRow

One line of the session history under the drill-down: number, defect, where it was found, classification and quantity.

**Use** one row per area + sub-area + defect + inspection type (the same grain as `M100_DEFECT_DETAIL`), with a `head` row on top. Flash the row that just changed and scroll it into view.

**Consumer provides:** `no`, `name`, `path` ("Area › Sub-area · Family · TYPE"), `classification`, `qty`, `flash`; or `head`.
