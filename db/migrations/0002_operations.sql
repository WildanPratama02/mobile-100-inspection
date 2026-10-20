-- Operations tables (doc 02 §5.3).

-- Tablets, managed by the CLI device:add / device:revoke / device:list. Only the SHA-256 of a key is stored (ADR-014).
CREATE TABLE devices (
  id           uuid        PRIMARY KEY,
  label        text        NOT NULL UNIQUE,
  key_sha256   bytea       NOT NULL UNIQUE CHECK (octet_length(key_sha256) = 32),
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  last_seen_at timestamptz
);

-- Admin app accounts; passwords are argon2id hashes.
CREATE TABLE admins (
  id            integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  failed_logins integer     NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until  timestamptz
);

-- One row per change made by an admin, a script or the system (doc 02 §5.2).
CREATE TABLE audit_log (
  id        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  actor     text        NOT NULL CHECK (actor = 'system' OR actor LIKE 'admin:_%' OR actor LIKE 'script:_%'),
  action    text        NOT NULL,
  entity    text        NOT NULL,
  entity_id text,
  details   jsonb
);

CREATE INDEX audit_log_at_idx ON audit_log (at);

CREATE TABLE settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- master_version: incremented in the same transaction as any master change; the /master-data ETag (doc 02 §3).
-- submit_enabled: readiness check SUBMIT_ENABLED (doc 02 §10).
INSERT INTO settings (key, value) VALUES
  ('master_version', '0'),
  ('submit_enabled', 'true');
