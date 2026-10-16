# ShoeMap

The tappable shoe on the Defect page: the product photo with the 12 area pills around it, each joined to its spot on the shoe by a leader line.

**Use**
- Inside the shoe-map `Pane` on the Defect page, with the inspection commands (REWORK, B-GRADE, NO DEFECT above; END INSPECTION below) outside the map.
- Pass `disabled` while no REWORK or B-GRADE inspection is active: every pill turns grey and the photo dims.
- Show the selected area with `areas[id].selected` and the defects recorded there in the active inspection with `areas[id].count`.

**Consumer provides:** `src` (the app's copy of `assets/erasebg-transformed.avif`), `areas` keyed by area ID (A01 Toe Box … A12 General, as in `M100_AREA_MAP`), `disabled`, `onSelect(areaId)`. `imageBox` and `layout` override the crop box and pill positions only if the photo is replaced.

**Do / don't**
- Do keep all 12 pills; General has no spot on the shoe, so it has no leader line and a dashed border.
- Don't make the photo itself the tap target; the pills are, at 44px tall.
