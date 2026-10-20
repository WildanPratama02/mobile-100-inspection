---
paths:
  - "apps/api/**/*.ts"
---

# API and spreadsheet rules

- Spec: `docs/03-tdd.md` §5 (modules, pipeline, errors), `docs/02-data-design.md` (columns, write sequence), `docs/04-api-contract.md` + `04-openapi.yaml` (endpoints). Phase 4 (deployment) is blocked, see CLAUDE.md.
- All Google access goes through the repository interfaces of doc 03 §5.2 (`UsersRepository`, `CellsRepository`, `DefectsRepository`, `AreaMapRepository`, `PoRepository`, `InspectionRepository`, `SubmissionLogRepository`, `PhotoStore`); controllers and services never call `googleapis` directly. Each interface has a Google implementation and an in-memory fake with fault injection.
- Spreadsheet ID, Drive folder ID and credentials come from environment variables / `secrets/` only. Tests run against the in-memory fakes or the development **copy**, never production.
- Append only (BR-07). A Submit PO is `values.append` (`RAW`) of the row, then **one** `spreadsheets.batchUpdate` (format copy, LINK formulas, detail rows, submission row). Read the ID columns of `M100_SUBMISSION` and `DATA_INSPECTION` fresh before writing, and verify that appended row N holds our ID before the batch (doc 03 §5.4).
- The API computes every total itself from counts and findings (doc 04 §4.1). Use the shared `top5()` for slot order.
- One worker writes to Sheets. Retry `429` with `2^n` s + up to 1 s jitter, cap 32 s; retry `5xx` and network errors for up to 10 minutes; never retry `400`. A Google `401/403/404` flips `SHEETS_ACCESS` or `DRIVE_ACCESS` and disables Submit PO (doc 03 §5.7).
- Never log device keys, tokens or photo bytes. Compare device keys by SHA-256 in constant time.
- Photos: accept JPEG only (signature `FF D8 FF`), ≤ 1 MB each, do not re-encode; upload before appending the row; file name from `photoFileName()`.
- The server is Windows: build file paths with `node:path`, never assume case-sensitive file names, and do not write bash-only scripts.
