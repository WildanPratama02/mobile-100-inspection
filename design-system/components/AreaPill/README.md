# AreaPill

A shoe-area label on the shoe map, connected to its spot by a leader line. The selected area is filled blue; the count badge shows defects recorded there in the active inspection.

**Use** inside `ShoeMap`, which places all twelve; use AreaPill alone only for a legend or a list. The twelve areas: Tongue, Eyestay/Lace, Vamp, Toe Box, Branding / Treatment, Midsole, Inside, Collar, Heel, Outsole / Bonding, Quarter, and General (`general`, dashed: not a place on the shoe). Disabled while no inspection is active.

**Consumer provides:** `label` or two `lines`, `selected`, `count`, `general`, `disabled`, `onClick`. The consumer draws the shoe illustration with the `shoe-*` tokens and the leader lines in `ink-2` (`ink` when selected).
