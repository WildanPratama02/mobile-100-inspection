# Top5Row

One row of the TOP 5 DEFECT table: rank, defect name with classification and areas, quantity, and the photo control.

**Use** five rows at most, sorted by quantity, then severity. Pass `photo` only for PSI lv.2; without it the photo column is dropped.

**Consumer provides:** `no`, `name` exactly as in `DEFECT_LIST`, `classification`, `areas` (comma-separated area names), `qty`, `photo` (PhotoButton props) or nothing.
