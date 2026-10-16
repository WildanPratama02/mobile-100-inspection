# Button

A softly rounded, uppercase action button in three variants: `primary` (blue), `secondary` (white with a grey border) and `danger`.

**Use**
- `primary` for the one action a screen is for: SUBMIT PO on Home, LOGIN, KIRIM in the Submit dialog, ADD TO PO LIST. At most one per view.
- `secondary` for every other action: the ADD DEFECT bar (`size="lg"`, `block`), EXPORT PDF, EXPORT EXCEL, ADD TO PO LIST when it isn't the main goal, GANTI FOTO, BATAL.
- `danger` only for LOGOUT and HAPUS (photo).

**Consumer provides:** the label (uppercase is applied by the style; write it as the user should read it), `onClick`, optional `icon` from the icon set, `size` (`md` default 52px, `lg` 58px for bars, `sm` 44px), `block` to fill the width, `disabled`.

**Do / don't**
- Do keep labels to the fixed English shop-floor words or a short Indonesian verb ("Ganti foto").
- Don't put two `primary` buttons side by side; don't use `danger` for anything reversible.
- A disabled button explains itself elsewhere on the screen (a Notice or the dialog's checks); never leave a button disabled with no reason visible.
