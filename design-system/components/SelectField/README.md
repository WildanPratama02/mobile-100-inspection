# SelectField

A captioned field that opens a picker. It replaces the keyboard: the PSI taps it and chooses from a list or grid in a `Dialog`.

**Use** on the login screen (Nama, Factory, Cell) and as the PO NUMBER trigger in Add PO (with `mono`).

**Consumer provides:** `label` (caption, set in caps), `value` or `placeholder`, `open` while its picker is showing, `onClick` to open the picker, `mono` for PO numbers.

**Do / don't**
- Do open a `Dialog` holding big option buttons (one per name, a grid for cells), at least `tap-min` tall.
- Don't use a native `<select>`: its list is too small for gloved hands.
