# Dialog

A rounded panel (`radius-lg`) with an uppercase title, a close button and a body, shown over the `scrim`.

**Use** for pickers (name, factory, cell), Add PO, the Submit PO confirmation, photo view, and blocking messages.

**Consumer provides:** `title`, `children`, `onClose` (or `false` for a dialog that must be answered), `wide` for the photo view, `role="alertdialog"` when it blocks. The consumer places it centred over `scrim` and closes it on scrim tap and Escape.

**Do / don't**
- Do end with the buttons, primary on the right.
- Don't stack dialogs; replace one with the next.
