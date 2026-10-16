# Stepper

A − / value / + control for a small whole number.

**Use** for the partial number P1, P2… on Add PO (`label` "Partial ke", `format` = v => 'P'+v, `min` 1, `max` 99).

**Consumer provides:** `value`, `min` (default 1), `max`, `format`, `label`, `onChange(v)`, `disabled`. Both buttons are 44px wide or more; a button at its limit turns grey (disabled), it does not hide.

**Do / don't**
- Don't use for large quantities; use `NumberPad`.
