---
paths:
  - "apps/web/src/**/*.{ts,tsx,css}"
---

# Web UI rules

- Read the matching `design-system/components/<Name>/README.md` before building or changing a component.
- Styles use only CSS variables from `design-system/tokens.css` (`var(--accent)`, `var(--radius-md)`, `var(--tap-min)` …). No hex or rgb values.
- Selected = `--accent` fill with `--on-accent` text. Disabled = `--disabled` fill with `--on-disabled` text (never opacity). Pressed = `--accent-soft`.
- Classification is always a word in a `Chip` (MINOR / MAJOR / CRITICAL); never colour a whole row by it.
- Every user-visible string is Bahasa Indonesia except the fixed English labels listed in `CLAUDE.md`.
- Format numbers with `Intl.NumberFormat('id-ID')` via the helpers in `packages/shared`.
- A tap handler writes to the store (which persists to Dexie) and gives feedback; it never awaits the network.
