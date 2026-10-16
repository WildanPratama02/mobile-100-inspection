# CommandButton

The inspection commands REWORK, B-GRADE, NO DEFECT and END INSPECTION on the defect screen.

**Use**
- Place REWORK, B-GRADE and NO DEFECT together above the shoe map, END INSPECTION below it, as in the wireframe.
- With no inspection active: the three start commands are `idle` (white, grey border), END INSPECTION is `disabled` (grey).
- While a REWORK or B-GRADE inspection is active: that command is `active` (blue), the other two are `disabled` (grey), END INSPECTION is `idle`.
- NO DEFECT records and completes a pair at once, so it is never `active`.

**Consumer provides:** `mode` (`rework`, `bgrade`, `nodefect`, `end`; the label follows), `state`, `onClick`.

**Do / don't**
- Do keep all four visible at all times; state, not presence, tells the PSI what is possible.
- Don't rename them or translate them.
