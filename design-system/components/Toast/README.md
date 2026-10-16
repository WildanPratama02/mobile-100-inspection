# Toast

A short message that confirms what just happened, shown at the top centre for about 1.4 s (3.2 s for errors).

**Use** after every defect tap ("+1 Defect", "+1 Defect dan B-Grade"), UNDO ("Undo defect terakhir"), and Submit PO ("PO terkirim 14:32", "Menunggu koneksi").

**Consumer provides:** the text, `tone="error"` for failures, `floating` to pin it to the top of the screen. One toast at a time; a new one replaces the old.

**Don't** put buttons in a toast or use it for anything the user must read twice; that is a `Notice`.
