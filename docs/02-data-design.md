# Mobile 100% Inspection — Data Design (Spreadsheet Schema)

| | |
|---|---|
| Version | 1.0 — approved by the product owner, 16 Oct 2026 |
| Date | 16 Oct 2026 |
| Spreadsheet | "100%INLINE IMPACTIVA" (owner `fnd.ahmad12@gmail.com`, time zone Asia/Bangkok = WIB) |
| Based on | A full read of `DATA_INSPECTION` rows 2–2371 (2,370 sessions, 3 Aug – 15 Oct 2026) and of `USER_LIST`, `DB_CELL`, `ALL_PO_MASTER`, `DEFECT_LIST`, `SUMMARY`, on 16 Oct 2026 |
| Related | ADR-001, 002, 003, 008, 009, 011, 012 in [07 Decision Log](07-decision-log.md); FR-10, FR-11, FR-13 in [01 PRD](01-prd.md) |

This document says exactly what the API reads from and writes to the spreadsheet. Every item is decided; the decisions taken during review are listed in §12.

## 1. What the existing data shows

These findings shape the design. Counts are for the 600 PSI rows unless stated.

| # | Finding | Consequence for Mobile 100% Inspection |
|---|---|---|
| D1 | `ID` is 8 lowercase hex characters (AppSheet `UNIQUEID()`), e.g. `a39deaf8`. | The API generates IDs in the same format and checks they are unused. |
| D2 | `DATE`, `CRD` are date serials shown as `dd/mm/yyyy`; quantities are numbers shown as `#,##0`; `RFT` and `DEFECT RATE` are numbers rounded to 3 decimals shown as `0.0%`; `PO` is text (keeps leading zeros). | Values are written as numbers/strings, not formatted text; the row's formats are copied from the row above. |
| D3 | **Every row has a spreadsheet formula in all 75 `LINK` cells**, the same per column: `=SUBSTITUTE(CONCATENATE("https://www.appsheet.com/template/gettablefileurl?appName=";"100PERCENTINLINEIMPACTIVA-227477299";"&tableName=";"DATA_INSPECTION";"&fileName=";W2371);" ";"%20")`, pointing at the `PHOTO` cell on its left. Rows below the data are empty. | AppSheet only keeps adding this formula to new rows while the column's formulas are consistent. A row with a plain value in a LINK cell makes the column "mixed": AppSheet then marks it read-only and stops adding the formula to new rows. Mobile 100% Inspection rows must therefore carry the same formula (§7). |
| D4 | `PHOTOk` holds the path `DATA_INSPECTION_Images/<ID>.PHOTO<k>.<HHmmss>.jpg`; *k* is the global photo number, `3(n−1)+j` for photo *j* of slot *n* (7,883 of 7,898 paths follow this exactly). | Same naming for Mobile 100% Inspection photos; the LINK formula then produces a working link. |
| D5 | An unused slot is written as `DEFECTn` = empty, `DEFECT NAMEn` = `-`, everything else empty (8,907 of 8,922 unused PSI slots). | Same pattern. |
| D6 | PSI sessions use 0–24 slots: median 10, 8 sessions used 20 or more, none used all 25. | 25 slots are enough for nearly every session; overflow is handled (§6.3) but should be rare. |
| D7 | Slots are in entry order, not by quantity (25 of 595 rows are sorted). The same defect name appears in two slots of one row in 114 rows. | Readers don't depend on slot order or unique names; Mobile 100% Inspection orders slots by quantity so slots 1–5 are the Top 5. |
| D8 | Photos are attached to 99% of used slots, **at both levels** (PSI lv.1: 832 of 852 slots; lv.2: 5,179 of 5,222). Per used slot: 1 photo 4,573×, 2 photos 989×, 3 photos 449×. | Mobile 100% Inspection deliberately takes fewer (decided 16 Oct 2026, §7): one photo per Top 5 defect, PSI lv.2 only. Its rows carry at most a handful of photos and none for PSI lv.1, a visible difference from AppSheet rows. |
| D9 | `TOTAL DEFECT` = sum of `QTY DEFECT n` (597/600). `QTY INSPECTION` = `A-GRADE` + `TOTAL DEFECT` in **600/600** rows, so `RFT` + `DEFECT RATE` = 100%. `B-GRADE` is empty or a small number, always ≤ `TOTAL DEFECT`. | Mobile 100% Inspection counts differently (ADR-008): one pair can carry several defects, so `QTY INSPECTION` ≠ `A-GRADE` + `TOTAL DEFECT` and the two rates don't add to 100%. See §9. |
| D10 | `INSPECTION BY`, `CFA NAME`, `HISTORYCAL PO`, `STATUS PO`, `PIC ADM` are empty in all 600 PSI rows. `CATEGORY` is `SHOES` in 596 rows (`COMPONENT UPPER` 3). `PARTIAL OF QTY PO` is empty in 412 rows, otherwise free text (`1`, `1200`, `P1 1200`). `C-GRADE` is empty in 598 rows. | Defaults in §5. |
| D11 | 132 used slots hold names that are not in `DEFECT_LIST` (`LONG SHORT`, `HEEL HIGHT`, `LINE UP`, `-`, empty…), typed by hand in AppSheet. | Mobile 100% Inspection writes only names from `DEFECT_LIST`. Reports already cope with other names. |
| D12 | `MODEL` and `DESTINATION` contain non-breaking spaces (U+00A0) in 2,347 of 2,370 rows, copied from `ALL_PO_MASTER`. | Copy PO fields byte for byte; never trim or normalise them, or joins with existing rows break. |
| D13 | `SUMMARY` holds plain values (no formulas), one row per defect, with `LINK` = the first photo link of each slot. It is produced outside the sheet (OQ-12). | Mobile 100% Inspection rows feed it as long as LINK columns behave like AppSheet's (D3). |
| D14 | `DATA_INSPECTION` grew by ~1,150 rows in September (PSI ~290). The file's grids hold ~3.95M cells of the 10M limit, of which `DATA_INSPECTION` is 1.48M (5,366 rows × 276, 3,000 of them empty) and `Copy of DATA_INSPECTION` 0.92M. At ~317k cells/month the file reaches 10M in about 19 months (around mid-2028). | Not caused by Mobile 100% Inspection, but it limits it. See §11. |

## 2. Sheets and who writes them

| Sheet | Mobile 100% Inspection | Notes |
|---|---|---|
| `USER_LIST` | reads | Login names (§3.1) |
| `DB_CELL` | reads | Factory / Cell (§3.2) |
| `ALL_PO_MASTER` | reads | PO search and PO fields (§3.3) |
| `DEFECT_LIST` | reads | Defect names and classification (§3.4) |
| `M100_AREA_MAP` | reads (new) | Area mapping (§4.1) |
| `DATA_INSPECTION` | appends 1 row per Submit PO | Existing format (§5–7) |
| `M100_DEFECT_DETAIL` | appends (new) | Where on the shoe, by inspection type (§4.2) |
| `M100_SUBMISSION` | appends 1 row per Submit PO (new) | Idempotency and audit (§4.3) |
| `SUMMARY`, `CFA DATA`, `REPACKING_DATA`, `Copy of DATA_INSPECTION`, `Sheet19`, `Sheet20` | never touched | — |

The API never edits or deletes an existing row in any sheet (BR-07). The only cells it writes after an append are the cells of the row it has just appended (§8).

## 3. Master data (read)

The API reads each sheet whole, caches it (FR-13: refresh on demand, at most every 30 minutes), and validates it at startup (§10).

### 3.1 `USER_LIST` — `ID`, `USERNAME`, `TYPE INSPECTION`

- Login list = distinct (`USERNAME`, `TYPE INSPECTION`) where `TYPE INSPECTION` ∈ {`PSI lv.1`, `PSI lv.2`}, sorted by name. On 16 Oct 2026: 14 people (6 lv.1, 8 lv.2).
- `ROIS FATHUR ROHIM` appears twice as `PSI lv.1` (IDs 4 and 36): shown once.
- `EVA JULIYANI` is both `CFA` and `PSI lv.1`: shown once, as `PSI lv.1`.
- A name listed at both PSI levels would be shown twice, once per level (none today).
- The session stores `USERNAME` and `TYPE INSPECTION` as text, exactly as in the sheet; `ID` is not used.

### 3.2 `DB_CELL` — `ID`, `FACTORY`, `CELL`

- Factory list = distinct `FACTORY` values of the form `F <number>`, in sheet order: today `F 1` … `F 5`. `PWA` and `BOTTOM` (cells `PWA` and `-`) are **not offered** (decided 16 Oct 2026). A new factory such as `F 6` appears automatically once it is added to `DB_CELL`.
- Cell list = `CELL` for the chosen factory (`F3-10`).

### 3.3 `ALL_PO_MASTER` — `PO`, `ARTICLE`, `MODEL`, `DESTINATION`, `ORDER QTY`, `PODD`, `CRD`, `Balance Prod`, `FINISH PRODUCTION`

- About 71,500 rows; all values are text, dates as ISO text (`2026-01-12`). `PO` keeps leading zeros and prefixes (`0902028839`, `CX-0902368685`).
- Search (FR-03): substring match on `PO`, `ARTICLE`, `MODEL`, case-insensitive, after 3 characters, at most 20 results. Which POs are offered is still open (OQ-06).
- The PO fields written to `DATA_INSPECTION` are copied byte for byte (D12).

### 3.4 `DEFECT_LIST` — `CTQ DEFECT CODE`, `DEFECT CLASSIFICATION`, `DEFECT NAME`, `CLASSIFICATION`

- 98 rows; row *r* (2–99) is `DEFECT_ID` D(*r*−1), e.g. row 2 = D001 (ADR-009).
- Mind the names: `DEFECT_LIST.DEFECT CLASSIFICATION` is the CTQ category ("Outer carton"); the **severity** is `DEFECT_LIST.CLASSIFICATION` (`MINOR` / `MAJOR` / `CRITICAL`). The severity is what goes into `DATA_INSPECTION.DEFECT CLASSIFICATION n`.
- D049 and D071 are both "POOR TOUCH UP/PAINTING, MARKING LINE" (MINOR).

## 4. New sheets

Created once by the maintainer (or a setup script run with their approval), with exactly these columns and no spare rows or columns, so they cost only the cells they use.

### 4.1 `M100_AREA_MAP` (read) — one row per mapping, 437 rows

| Column | Example | Rule |
|---|---|---|
| `MAP_ID` | `MAP-035-03` | Unique |
| `AREA_ID` | `A03` | A01–A12 |
| `AREA_NAME` | `Quarter` | |
| `AREA_ORDER` | `3` | Display order |
| `SUB_AREA_ID` | `SA03L` | Belongs to `AREA_ID` |
| `SUB_AREA_NAME` | `Lateral Quarter` | |
| `SUB_AREA_ORDER` | `3` | |
| `FAMILY_ID` | `F03` | |
| `FAMILY_NAME` | `Stitching` | |
| `DEFECT_ID` | `D035` | D001–D098 |
| `DEFECT_NAME` | `BROKEN STITCHING/LOOSE STITCHING/SKIPPED STITCHING/OPEN SEAM` | Must equal `DEFECT_LIST` row of `DEFECT_ID` |
| `CLASSIFICATION` | `MAJOR` | Must equal `DEFECT_LIST.CLASSIFICATION` |
| `ACTIVE` | `TRUE` | `FALSE` hides the row without deleting it |

Loaded from `Footwear_Defect_Mapping_Database_v2.xlsx` (sheets `Defect_Area_Map`, `Area_Master`, `SubArea_Master`, `Defect_Family`, `Defect_Master`) by a one-time import.

### 4.2 `M100_DEFECT_DETAIL` (write) — one row per area + sub-area + defect + inspection type

| Column | Example | Rule |
|---|---|---|
| `DI_ID` | `5be0c1a7` | `ID` of the `DATA_INSPECTION` row |
| `SUBMISSION_UUID` | `0f6b…` | From the tablet |
| `INSPECTION_TYPE` | `REWORK` | `REWORK` or `B-GRADE` |
| `AREA_ID` | `A03` | |
| `SUB_AREA_ID` | `SA03L` | |
| `FAMILY_ID` | `F03` | |
| `DEFECT_ID` | `D035` | |
| `DEFECT_NAME` | `BROKEN STITCHING/…` | Copy, for readability |
| `CLASSIFICATION` | `MAJOR` | Copy |
| `QTY` | `2` | ≥ 1 |
| `SLOT` | `3` | The `DATA_INSPECTION` slot holding this defect, or empty if it overflowed (§6.3) |

Header fields (date, inspector, PO, cell…) are not repeated: join on `DI_ID`. Names of areas and families come from `M100_AREA_MAP`. This keeps the sheet at 11 columns (§11).

### 4.3 `M100_SUBMISSION` (write) — one row per Submit PO

Needed because a session made only of NO DEFECT pairs has no detail rows, so the detail sheet alone can't prove a submission was written.

| Column | Example | Rule |
|---|---|---|
| `SUBMISSION_UUID` | `0f6b…` | Unique; idempotency key |
| `DI_ID` | `5be0c1a7` | |
| `SEALED_AT` | `16/10/2026 14:32:05` | When the PSI tapped KIRIM (WIB), datetime serial |
| `WRITTEN_AT` | `16/10/2026 14:32:09` | When the API finished |
| `QTY_REWORK` | `10` | Number of REWORK inspections |
| `QTY_BGRADE` | `2` | Number of B-GRADE inspections |
| `QTY_NO_DEFECT` | `18` | |
| `PHOTO_COUNT` | `5` | |
| `PARTIAL_NO` | `1` | Empty when the PO isn't partial |
| `PARTIAL_QTY` | `1200` | Empty when the PO isn't partial |
| `OVERFLOW_DEFECTS` | `0` | Distinct defects that didn't fit in 25 slots |
| `APP_VERSION` | `1.0.0` | |

Written last (§8); a row here means the submission is complete.

## 5. `DATA_INSPECTION` row — header and totals

Column letters are the sheet's. "Copy" means copied unchanged from the source.

| Col | Header | Value written | Type / format |
|---|---|---|---|
| A | `ID` | New 8-hex ID (§8.1) | text |
| B | `DATE` | Date of `SEALED_AT` (WIB) | date serial, `dd/mm/yyyy` |
| C | `INSPECTOR` | `USERNAME` | text |
| D | `TYPE INSPECTION` | `PSI lv.1` / `PSI lv.2` | text |
| E | `INSPECTION BY` | empty (decided 16 Oct 2026) | |
| F | `CFA NAME` | empty (decided) | |
| G | `HISTORYCAL PO` | empty (decided) | |
| H | `FACTORY` | from login, e.g. `F 3` | text |
| I | `CELL` | from login, e.g. `F3-10` | text |
| J | `CATEGORY` | always `SHOES` (decided 16 Oct 2026) | text |
| K | `PO` | Copy of `ALL_PO_MASTER.PO` | text (TEXT format) |
| L | `ARTICLE` | Copy | text |
| M | `MODEL` | Copy (byte for byte, D12) | text |
| N | `DESTINATION` | Copy (byte for byte) | text |
| O | `QTY ORDER` | `ORDER QTY` as a number | number, `#,##0` |
| P | `CRD` | `CRD` ISO text → date | date serial, `dd/mm/yyyy` |
| Q | `PARTIAL OF QTY PO` | PO PARTIAL off: empty. On: `P<n> <qty> OF <QTY ORDER>`, numbers in Indonesian format, e.g. `P1 1.200 OF 10.002` (ADR-013) | text |
| R | `QTY INSPECTION` | Qty Inspection (BR-01) | number |
| S–JH | 25 defect slots | §6 | |
| JI | `A-GRADE` | Qty A-Grade | number |
| JJ | `B-GRADE` | Qty B-Grade; empty when 0 (as existing rows) | number |
| JK | `C-GRADE` | empty | |
| JL | `TOTAL DEFECT` | Qty Defect = sum of all defects, including any overflow (§6.3) | number |
| JM | `RFT` | round(A-Grade ÷ Qty Inspection, 3) | number, `0.0%` |
| JN | `DEFECT RATE` | round(Qty Defect ÷ Qty Inspection, 3) | number, `0.0%` |
| JO | `STATUS PO` | empty (ADR-012) | |
| JP | `PIC ADM` | empty (ADR-012) | |

Submit PO is refused when Qty Inspection is 0 (FR-11), so the rates always have a denominator.

## 6. Defect slots

Slot *n* (1–25) occupies 10 columns starting at column 19 + 10(*n*−1): `DEFECTn`, `DEFECT NAMEn`, `DEFECT CLASSIFICATION n`, `QTY DEFECT n`, then `PHOTO(3n−2)`, `LINK(3n−2)`, `PHOTO(3n−1)`, `LINK(3n−1)`, `PHOTO(3n)`, `LINK(3n)`. Slot 1 = S–AB, slot 2 = AC–AL, … slot 25 = IY–JH.

### 6.1 One slot per defect

The session's findings are grouped by `DEFECT_ID`, adding up quantities across areas, sub-areas and inspection types. D049 and D071 stay separate slots even though their names are equal (allowed, D7).

### 6.2 Slot order

1. Higher total quantity first;
2. then higher severity (CRITICAL, MAJOR, MINOR);
3. then the defect recorded first.

This is the Top 5 order of FR-05 (AC-05.1), so slots 1–5 are the Top 5 shown on Home.

### 6.3 More than 25 distinct defects

Slots 1–25 take the first 25 defects in that order. The rest are written only to `M100_DEFECT_DETAIL` with `SLOT` empty, and counted in `M100_SUBMISSION.OVERFLOW_DEFECTS`. `TOTAL DEFECT` and `DEFECT RATE` still include them, so the row's totals stay correct even though the slots don't add up. A photographed defect is moved ahead of unphotographed ones only if it would otherwise overflow, so no photo is lost. (Existing PSI sessions never exceeded 24 slots, D6.)

### 6.4 Used slot

| Column | Value |
|---|---|
| `DEFECTn` | `ADD` |
| `DEFECT NAMEn` | `DEFECT_LIST.DEFECT NAME` |
| `DEFECT CLASSIFICATION n` | `DEFECT_LIST.CLASSIFICATION` |
| `QTY DEFECT n` | total quantity (number) |
| `PHOTO(3n−2)` | the photo path when the defect has a photo (PSI lv.2, §7), otherwise empty |
| `PHOTO(3n−1)`, `PHOTO(3n)` | always empty |
| `LINK(3n−3+j)` | the LINK formula (§7), always |

### 6.5 Unused slot

`DEFECTn` empty, `DEFECT NAMEn` = `-`, `DEFECT CLASSIFICATION n`, `QTY DEFECT n` and the three `PHOTO` cells empty, the three `LINK` cells = the LINK formula (D3, D5).

## 7. Photos (ADR-011)

**Mechanism (decided 16 Oct 2026).** The analysis (D3, D4) shows that the LINK columns are formulas AppSheet copies into every new row. Writing a bare Drive URL into them would break that for AppSheet's own future rows. The design that keeps both apps working:

1. The API uploads each photo to Google Drive, into the folder AppSheet already uses for this table, `DATA_INSPECTION_Images` (in the sheet owner's Drive, in the app's data folder).
2. File name: `<ID>.PHOTO<k>.<HHmmss>.jpg`, where *k* = 3(*n*−1)+1 for the defect in slot *n* and `HHmmss` is the sealed time in WIB. Example: the photo of the defect in slot 2 of row `5be0c1a7` sealed at 14:32:05 → `5be0c1a7.PHOTO4.143205.jpg`.
3. `PHOTOk` = `DATA_INSPECTION_Images/<file name>`.
4. `LINKk` = the same formula as every other row, pointing at its own row's `PHOTOk` cell. It evaluates to `https://www.appsheet.com/template/gettablefileurl?appName=100PERCENTINLINEIMPACTIVA-227477299&tableName=DATA_INSPECTION&fileName=DATA_INSPECTION_Images/5be0c1a7.PHOTO4.143205.jpg`, which opens the photo from Google Drive, exactly like AppSheet's links.

Result: the photo is in Google Drive, its link is in `LINK1` … `LINK75`, the AppSheet app shows Mobile 100% Inspection photos, and `SUMMARY` picks up the links as before.

**Who uploads.** A service account has no Drive storage and can't own files in a personal Drive, and this Drive belongs to a personal account, so there is no Shared Drive or domain-wide delegation. The API therefore uploads with the OAuth credentials of the sheet owner's account, **`fnd.ahmad12@gmail.com`** (decided 16 Oct 2026), which owns `DATA_INSPECTION_Images`. The owner grants consent once with the `https://www.googleapis.com/auth/drive` scope (the narrower `drive.file` only reaches files the app created itself, not the existing folder); the resulting refresh token is a server secret, never stored in the repo or on tablets. If the owner changes the password or revokes access, uploads stop and Submit PO is disabled until consent is given again (§10 check 6). Sheets access stays with the service account (ADR-004), shared as Editor on the spreadsheet.

**Photo rule (decided 16 Oct 2026, FR-10).**
- **PSI lv.2:** exactly one photo for each defect in the Top 5 at Submit PO (BR-04). It goes into the first photo pair of the defect's slot, so in practice `PHOTO1`, `PHOTO4`, `PHOTO7`, `PHOTO10`, `PHOTO13` (slots 1–5). A defect photographed while in the Top 5 that later dropped out keeps its photo in the first pair of its own slot (AC-10.4).
- **PSI lv.1:** no photos. Every `PHOTO` cell of the row is empty; the `LINK` formulas are still written.
- JPEG, at most 960 px on the long edge (AC-10.1), about 100–200 KB.

**Formula text.** The API does not hard-code the formula. At startup it reads the 75 LINK formulas of the last data row, checks that each refers to the `PHOTO` cell on its left in the same row, and keeps them as templates; for a new row it substitutes the row number. If the templates are missing or differ between columns, Submit PO is disabled and the API reports it (§10).

## 8. Writing a submission

### 8.1 ID

`ID` = the first 8 hex characters of SHA-256(`SUBMISSION_UUID`), lowercase. If that ID already exists in `DATA_INSPECTION` for a different submission, take the next 8 characters. Deriving the ID from the UUID makes every step below safe to repeat.

### 8.2 Sequence (single-writer queue in the API)

1. **Already written?** If `M100_SUBMISSION` has the UUID, return its `DI_ID` (BR-06).
2. **Photos.** For each photo, look for a file with its name in `DATA_INSPECTION_Images`; upload only if missing.
3. **Row exists?** If `DATA_INSPECTION` already has the ID (an earlier attempt stopped after this step), take its row number and go to 5.
4. **Append** the row: `spreadsheets.values.append` on `DATA_INSPECTION!A:JP`, `valueInputOption=RAW`, `insertDataOption=OVERWRITE`, with every value of §5–6 and the LINK cells left empty. The response's `updatedRange` gives the row number *N*.
5. **Complete** in one `spreadsheets.batchUpdate`:
   - copy formats of row *N*−1 to row *N* (`copyPaste`, `PASTE_FORMAT`), which gives the date, number, text and percent formats of D2;
   - write the 75 LINK formulas for row *N* (`updateCells`);
   - append the detail rows to `M100_DEFECT_DETAIL` (`appendCells`);
   - append the row to `M100_SUBMISSION` (`appendCells`).
6. Return `DI_ID` to the tablet.

Two Sheets writes per submission (steps 4 and 5) plus small reads that are always done fresh, never from a cache, because they decide whether to write: the ID columns of `M100_SUBMISSION` (step 1) and `DATA_INSPECTION` (step 3), and a check that the appended row *N* holds our ID before step 5 (doc 03 §5.4). This replaces "one batch request" in ADR-002 and NFR-06/07: the Sheets API can't append a row and fill formulas that reference its own row number in one request without knowing the row in advance, and guessing the row would race with AppSheet. If step 5 fails, the row exists without LINK formulas for a few seconds; the retry repeats step 5 only. Steps 1–5 run under the 429 back-off of NFR-07.

### 8.3 Values

Numbers are written as numbers, dates as serial numbers (days since 30 Dec 1899, WIB date), text as strings, empty cells as empty strings. Nothing is written as pre-formatted text ("2.400", "18,8%").

## 9. How Mobile 100% Inspection numbers differ from existing rows

Example session: 10 REWORK pairs with 8 defects, 2 B-GRADE pairs with 3 defects, 18 NO DEFECT pairs.

| Column | Mobile 100% Inspection (ADR-008) | Existing PSI convention (D9) |
|---|---|---|
| `QTY INSPECTION` | 30 | 30 |
| `A-GRADE` | 18 (NO DEFECT taps) | 30 − 11 = 19 |
| `B-GRADE` | 3 (per finding) | small number entered by hand |
| `TOTAL DEFECT` | 11 | 11 |
| `RFT` | 60.0% | 63.3% |
| `DEFECT RATE` | 36.7% | 36.7% |
| RFT + Defect Rate | 96.7% | always 100% |

Both rates use the same formulas; only `A-GRADE` is counted differently. A report that assumes `A-GRADE` = `QTY INSPECTION` − `TOTAL DEFECT`, or that RFT + Defect Rate = 100%, will disagree with Mobile 100% Inspection rows. Mobile 100% Inspection rows can be told apart by their `M100_SUBMISSION` entry (join on `ID` = `DI_ID`).

## 10. Startup validation (API)

Submit PO is disabled, and the reason is logged and shown in the gear menu, if any of these fail:

1. All seven read sheets exist with the headers in §3–4, in that order.
2. `DATA_INSPECTION` has exactly the 276 headers of the current layout (`ID` … `PIC ADM`).
3. `DEFECT_LIST` has 98 rows, and for every `DEFECT_ID` in `M100_AREA_MAP` the name and classification match its `DEFECT_LIST` row.
4. Every `SUB_AREA_ID` in `M100_AREA_MAP` belongs to its `AREA_ID`; `MAP_ID` is unique.
5. The 75 LINK formula templates were read and are consistent (§7).
6. The API can list `DATA_INSPECTION_Images` with its Drive credentials.

Login and inspection keep working offline while Submit PO is disabled; submissions wait in the outbox.

## 11. Capacity

| Item | Cells |
|---|---|
| Whole file today (all grids) | ~3.95M of 10M |
| `DATA_INSPECTION` growth, all sources | ~317k / month (≈1,150 rows × 276) |
| Mobile 100% Inspection, if it replaces PSI AppSheet rows (~290 / month) | no extra `DATA_INSPECTION` cells; `M100_DEFECT_DETAIL` ≈ 290 × ~12 rows × 11 = 38k / month; `M100_SUBMISSION` ≈ 3k / month |
| Time to 10M at today's pace | ~19 months (around mid-2028) |

Recommendations for the sheet owner, outside Mobile 100% Inspection's scope: remove `Copy of DATA_INSPECTION` (0.92M cells) and the ~3,000 empty rows at the bottom of `DATA_INSPECTION` (0.83M), and plan a yearly archive of `DATA_INSPECTION` into a separate file. The repository layer (ADR-004) lets Mobile 100% Inspection move to another store when that time comes.

## 12. Decisions taken during review

| # | Question | Default in this document |
|---|---|---|
| Q1 | ~~Photo link mechanism~~ | **Decided 16 Oct 2026:** AppSheet's `DATA_INSPECTION_Images` folder + the existing LINK formula (§7) |
| Q2 | ~~Photos per defect, PSI lv.1~~ | **Decided 16 Oct 2026:** one photo per Top 5 defect for PSI lv.2; PSI lv.1 uploads no photos (§7) |
| Q3 | ~~Uploading account~~ | **Decided 16 Oct 2026:** the sheet owner `fnd.ahmad12@gmail.com` (§7) |
| Q4 | ~~Header columns~~ | **Decided 16 Oct 2026:** `CATEGORY` = `SHOES`; `INSPECTION BY`, `CFA NAME`, `HISTORYCAL PO`, `C-GRADE` empty; `PARTIAL OF QTY PO` from the PO PARTIAL input (§5) |
| Q5 | ~~`M100_SUBMISSION`~~ | **Decided 16 Oct 2026:** added (§4.3) |
| Q6 | ~~Factories at login~~ | **Decided 16 Oct 2026:** only `F <number>` factories; `PWA` and `BOTTOM` hidden (§3.2) |
| Q7 | ~~Text of `PARTIAL OF QTY PO`~~ | **Decided 16 Oct 2026:** two structured inputs, written as `P<n> <qty> OF <QTY ORDER>` (`P1 1.200 OF 10.002`) |
