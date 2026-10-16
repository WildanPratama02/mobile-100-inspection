# OutboxItem

One submitted session in the tablet's outbox, with its status in words: Menunggu, Mengirim, Terkirim, Gagal.

**Use** in the gear menu's outbox list (PRD FR-11). Order newest first.

**Consumer provides:** `po`, `time` (WIB, HH:mm), `status`, and `reason` for `failed` (the server's message) or `detail` for waiting.

**Do** keep failed items until the user sees them; they are never removed silently.
