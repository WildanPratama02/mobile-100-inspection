---
paths:
  - "apps/api/**/*.ts"
  - "db/**"
  - "scripts/**"
---

# API and database rules

- Spec: `docs/03-tdd.md` §5 (modules, Submit PO procedure, errors), §6 (security, roles); `docs/02-data-design.md` (tables, constraints, import, write order, photo keys, views, readiness checks); `docs/04-api-contract.md` + `04-openapi.yaml` (endpoints, validation, error codes, admin API). Phase 4 (deployment) starts after the server pre-checks of doc 03 §7.3.
- Controllers and services depend on repository interfaces and on `PhotoStore` (doc 03 §5.2), never on `pg` or the file system directly. Repositories have a PostgreSQL implementation only; their tests run against a real PostgreSQL 16 test database, not a fake.
- Schema changes are explicit SQL files in `db/migrations/`, applied by `pnpm db:migrate` with `MIGRATE_DATABASE_URL` (role `m100_migrate`). No TypeORM `synchronize`, no schema auto-sync. The API runs as `m100_app`; `m100_report` reads the views only.
- Parameterised SQL only. Connection strings, `jwt.key` and S3 keys come from `.env` / `secrets/`; never hard-code them, never commit them. Development and tests use their own databases (`m100_dev`, a test database per run), never the production one.
- Submissions are immutable (BR-07, ADR-018): never UPDATE or DELETE `submissions`, `submission_findings` or `submission_photos`; the trigger and the grants enforce it. Master data is never deleted either, only deactivated (`active = false`).
- A Submit PO follows doc 02 §6.1 exactly: look up the UUID (`200` for the same `payload_sha256`, `409 SUBMISSION_UUID_REUSED` for a different one); validate at `REPEATABLE READ`; put photos **before** the transaction; then one transaction with `INSERT … ON CONFLICT (id) DO NOTHING`, findings and photo rows with snapshot columns, and the SQL re-check of the sums. Synchronous answer only: no queue, no `202`, no status endpoint.
- The API computes every total itself from counts and findings (doc 04 §4.1) with the functions in `packages/shared`; use the shared `rankDefects()` / `top5()` for the Top 5 so tablet and server never disagree. Accept fractional seconds in `sealedAt` and `firstRecordedAt` (doc 03 §4.6).
- Photo keys: `submissions/<yyyy>/<MM>/<uuid>/<defectId>.jpg`, month from `sealedAt` in WIB (doc 02 §7). JPEG only (signature `FF D8 FF`), ≤ 1 MB each, SHA-256 checked, never re-encoded. `DiskPhotoStore` writes to a temp file and renames, and refuses a key that escapes `PHOTO_DIR`.
- A database or photo-store error flips the matching readiness check (`DB`, `PHOTO_STORE`) and the request answers `503 DB_UNAVAILABLE` / `PHOTO_STORE_UNAVAILABLE` (doc 03 §5.7). A serialization failure or deadlock is retried once inside the request.
- Tablet tokens (`aud` = `tablet`) and admin cookies (`aud` = `admin`) never work on each other's endpoints. Every admin change and every CLI change writes an `audit_log` row and, when tablets download it, bumps `settings.master_version`.
- Never log device keys, tokens, passwords or photo bytes. Store only the SHA-256 of a device key and compare in constant time. Admin passwords are argon2id.
- The server is Windows: build file paths with `node:path`, never assume case-sensitive file names, and write CLI tools in Node/TypeScript or PowerShell, never bash.
