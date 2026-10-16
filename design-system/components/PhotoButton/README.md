# PhotoButton

The photo control in a Top 5 Defect row: add a photo, a required one is missing, or a thumbnail of the attached one.

**Use** for PSI lv.2 only (PRD FR-10). `required` when a Top 5 defect has no photo; `attached` once it has one (tap to view, replace or delete).

**Consumer provides:** `state`, `src` of the thumbnail for `attached`, `onClick` (open the camera, or the photo view).
