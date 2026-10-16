## Principles

- Modern Industrial Design System UI
- the color, Font, and size of Component UI  should be responsiveness and thouchable

Mobile 100% Inspection is a tap-only tablet tool for PSI on the production line, and it looks like the shop floor it serves.

- **Industrial, not rigid.** A white app with very light grey panes, softly rounded corners, 1px rules and condensed capitals that read at arm's length. Black is only ever text; one blue marks what is selected, active or next. Grey means disabled. No gradients and no decorative shadows.
- **Touchable.** Every control is at least `tap-min` (44px) in both directions, rows at least `row-min`, bars `bar-h`. A finger never has to hit something smaller, on any screen.
- **Responsive.** The same components serve a 10" tablet in landscape, a short landscape phone and a portrait screen. Type and spacing step down in compact layouts; touch sizes never do (see Responsive layout).

## Content fundamentals

- **Language.** Screen text is Bahasa Indonesia, written plainly: "Pilih area sepatu", "Belum ada defect", "Foto wajib", "PO terkirim".
- **Fixed shop-floor labels stay in English and uppercase**, because PSI already know them: ADD DEFECT, REWORK, B-GRADE, NO DEFECT, END INSPECTION, BACK, HOME, UNDO, SUBMIT PO, LOGIN, EXPORT PDF, EXPORT EXCEL, TOP 5 DEFECT, QTY INSPECTION, DEFECT RATE, PASS RATE (RFT).
- **Defect names are copied exactly** from `DEFECT_LIST`, mixed case and brackets included: "OVER CEMENTING OR PRIMING ( YELLOWING OR DISCOLORATION) (<4mm length, <2mm width)". Never shorten, translate or re-case them.
- **Numbers use Indonesian format** on screen: 2.400 pairs, 18,8%. Show "—" for a rate that can't be computed yet.
- **Messages say what happened, then what to do**: "Selesaikan inspeksi dulu (END INSPECTION)". No apologies, no exclamation marks, no emoji.
- A button names its action; a toast confirms it in a few words: SUBMIT PO → "PO terkirim 14:32".

## Using tokens

grey color pallete for dissable component, white color Background App,

**White is the app.** The app background is `bg` (white). Rows, cards, buttons and dialogs are `surface` (white).

**Very light grey panes.** The PO list column, the Top 5 area, the results box and the shoe-map pane are `Pane`s on `panel`, so the white rows inside them stand out. Table headers and field fills use `surface-sunken`. Hairlines are `line`; borders of controls are `line-strong`.

**Grey is disabled.** A disabled button, command, row or pill fills with `disabled` (a darker grey than `panel`) and sets its text in `on-disabled`. Disabled controls turn grey; they never just fade, so a PSI can tell "not now" from "not there".

**Black is text.** `ink` is for text only: body, labels, numbers. Labels and secondary text use `ink-2`, metadata `ink-3`. All three meet 4.5:1 on `bg`, `panel`, `surface` and `surface-sunken` in both themes. Black is never a fill.

**Blue is selected, active and next.** `accent` is the only hue that is not a status. Use it for:
- selected items: the selected PO, the selected shoe area, the current breadcrumb;
- the active inspection type (REWORK or B-GRADE while it runs);
- the primary action of a screen, one per view (SUBMIT PO on Home, LOGIN on login);
- count badges and links.
Text on an accent fill is `on-accent`. `accent-soft` is the pressed state of white controls, the tap flash and the tint of a row that just changed.

**Classification and status.**
- Classification is fixed by the defect list and always shown as a word in a chip: MINOR (`minor` on `minor-soft`), MAJOR (`major` on `major-soft`), CRITICAL (`on-critical` on `critical`, the only solid one). Never colour a row by classification.
- Status: `success` (sent, photo attached), `warning` on `warning-soft` (waiting, incomplete), `danger` (failed, missing photo, logout). Each status always carries a word too.
- The shoe map is a product photo (see Shoe map image); no token colours are painted on it except the leader lines and pills.

**Type.** Barlow Condensed (`display`) for every label, button, title and number; Barlow Semi Condensed (`body`) for running text and defect names; IBM Plex Mono (`mono`) for PO numbers and codes. `label`, `caption`, `chip`, `action*` and `title` are uppercase with letter-spacing; `body` is sentence case. Numbers that line up use tabular numerals. Load the three families from Google Fonts.

**Shape.** Slightly rounded, never sharp and never bubbly. Chips, badges in rows and breadcrumbs use `radius-sm`; buttons, inspection commands, fields, area pills, photo buttons, toasts and notices use `radius-md`; panes (`Pane`), lists of rows (`List`) and dialogs use `radius-lg`; count badges are round (`radius-full`). Rows inside a List stay square and are separated by a 1px `line`; the List rounds the group. Borders are 1px (`line` for hairlines, `line-strong` for controls). `shadow-overlay` is only for dialogs, pickers and toasts.

**Spacing.** `space-2` between siblings, `space-3` inside rows, `space-4` panel padding and the minimum side gutter, `space-5` dialog padding.

**States.**
- Pressed: white controls turn `accent-soft`; accent buttons darken.
- Selected: `accent` fill, `on-accent` text.
- Disabled: `disabled` fill, `on-disabled` text, no pointer. Area input is disabled until REWORK or B-GRADE is tapped.
- Just changed: `accent-soft` flash with a 6px `accent` inset at the left, fading in 0.5s.
- Focus: a 3px solid `focus` outline, at least 3:1 on every ground.

**Motion.** Only feedback, and short: colour changes on press and select ease over 0.12s, the tap flash lasts 0.5s, the toast slides in over 0.18s. Nothing animates on its own. With reduced motion, all of it is off.

## Responsive layout

Three layouts, chosen by the screen, never by the device name:

| Layout | When | What changes |
|---|---|---|
| Regular | landscape, height above 480px (10" tablet) | Home: PO column, Top 5 Defect, results box, ADD DEFECT bar. Defect screen: shoe map pane (about 56%) beside the drill-down, history and BACK / HOME / UNDO. Type at the sizes in the type scale. |
| Compact | landscape, height 480px or less (phone on its side) | Same arrangement. Titles step down (`title` 22px, `action-xl` 25px, `action-lg` 21px, `stat` 21px), row padding tightens to `space-2`. Touch sizes stay at `tap-min`, `row-min` and `bar-h`. |
| Stacked | portrait, or width 640px or less | Panes stack: info strip, PO list as a horizontal strip, results, Top 5. Defect screen: shoe map on top at its own aspect ratio, then the list, history and a bottom bar stuck to the screen edge with the safe-area inset. |

The page body never scrolls sideways; long defect names wrap inside their row.

## Using components

The `M100` namespace holds the building blocks the screens are made of; each has guidelines and a live preview.

- **Actions:** `Button`, `CommandButton`, `BottomBar`.
- **Inputs:** `SelectField` (opens a picker instead of a keyboard), `CheckboxRow`, `Stepper`, `NumberPad` (in-app digits, no keyboard), `Dialog`.
- **Status:** `Chip`, `CountBadge`, `Toast`, `Notice`, `OutboxItem`.
- **Results:** `POListItem`, `StatRow`, `Top5Row`, `PhotoButton`.
- **Inspection:** `ShoeMap`, `AreaPill`, `Breadcrumb`, `OptionRow`, `HistoryRow`.
- **Foundations:** `Pane`, `List`, `Icon`.

Easy to misuse:
- `Button` `primary` is for the one thing a screen is for. Two blue buttons side by side means one of them should be `secondary`.
- `CommandButton` keeps all four commands visible; state, not presence, tells the PSI what is possible.

Screens themselves (Login, Home, Defect) are specified in the UI/UX spec, not here.

## Accessibility

- `ink`, `ink-2` and `ink-3` meet 4.5:1 on `bg`, `panel`, `surface` and `surface-sunken`; `on-accent`, `on-critical` and `on-danger` meet 4.5:1 on their fills; each classification text meets 4.5:1 on its soft fill. Checked in both themes.
- `line-strong`, `accent` and `focus` meet 3:1 as borders and rings on every ground.
- Classification, inspection type and send status are always words. Colour supports them; it never carries them alone.
- Every tappable thing is at least 44 × 44px. An icon standing alone (the gear, the add-PO +) has an accessible label.

## Iconography

Simple line icons on a 24px grid, 2px stroke, round caps and joins, no fill, drawn in `currentColor` so they take the text colour. The set is fixed: `plus`, `chevron-down`, `chevron-right`, `back`, `home`, `undo`, `check`, `close`, `camera`, `download`, `gear`. Use the `Icon` component; no icon font, no emoji. An icon sits beside a word on buttons.

## Logo

The company mark is `assets/Logos/parkland.png`: the PT Parkland World Indonesia monogram in blue (about #0074B0) on a transparent background (275 × 249 px). Mobile 100% Inspection has no product logo of its own, so this mark is the app's logo.
- **Where:** centred above the form on the login screen (64px high; 48px in Stacked), above the title on the setup and start screens (72px), at the left end of the Home header (36px, hidden in Compact), at the top of the gear menu (32px), in the header of exported PDF reports (32px), and as the PWA icon and splash.
- Place it on `bg` or `surface` only, at least 32px tall, with clear space of `space-3` around it. It appears once per screen.
- Never recolour, stretch, outline or put it on `accent`.
- The logo keeps its own blue. The interface accent stays `accent` (#1D4ED8); don't match one to the other.
- PWA icons are the mark centred on a white square: 192px and 512px at 60% of the square, and a maskable 512px at 42%. The source is small, so the 512px icon is slightly soft; replace it if a vector or larger file is available.

## Shoe map image

The footwear photo `assets/erasebg-transformed.avif` is the picture PSI tap on the Defect page (via `ShoeMap`).
- It is a 2000 × 2000 px side view with a transparent background; the shoe fills x 352–1647, y 543–1457. `ShoeMap` crops to that box and places the 12 area anchors in those pixel coordinates, so a replacement photo must keep the same framing or come with new anchors.
- Show it on `panel` (the shoe-map `Pane`), never on a coloured fill, never cropped tighter than the shoe and never recoloured.
- While no inspection is active the photo dims to half strength along with the disabled pills, so the PSI sees at a glance that areas can't be tapped yet.
