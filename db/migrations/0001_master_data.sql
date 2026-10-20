-- Master data (doc 02 §3). Imported once (doc 02 §5.1), then kept in the admin app; rows are deactivated, never
-- deleted, because submissions refer to them.

-- PO search (FR-03.2, doc 02 §3.3). pg_trgm is a trusted extension, so the database owner may create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- §3.1. A name present at both levels is two rows.
CREATE TABLE psi_users (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username   text        NOT NULL,
  level      text        NOT NULL CHECK (level IN ('PSI lv.1', 'PSI lv.2')),
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (username, level)
);

-- §3.2
CREATE TABLE factories (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text        NOT NULL UNIQUE,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cells (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  factory_id integer     NOT NULL REFERENCES factories (id) ON DELETE RESTRICT,
  code       text        NOT NULL UNIQUE,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cells_factory_id_idx ON cells (factory_id);

-- §3.3. Text is stored exactly as imported (D3): leading zeros, prefixes and non-breaking spaces are kept.
-- article, model and destination are copied into every submission, where they are NOT NULL; an empty value is ''.
CREATE TABLE pos (
  po          text        PRIMARY KEY,
  article     text        NOT NULL,
  model       text        NOT NULL,
  destination text        NOT NULL,
  order_qty   integer     NOT NULL CHECK (order_qty >= 1),
  podd        date,
  crd         date,
  finished    boolean,
  active      boolean     NOT NULL DEFAULT true,
  source      text        NOT NULL CHECK (source = 'admin' OR source LIKE 'import:_%'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Non-breaking spaces become spaces in the index expression only, never in the stored data (doc 02 §3.3).
-- The PO search (T2.6) must use exactly this expression to hit the index.
CREATE INDEX pos_search_trgm_idx ON pos
  USING gin (lower(replace(po || ' ' || article || ' ' || model, U&'\00A0', ' ')) gin_trgm_ops);

-- §3.4. DEFECT_ID D001–D098 (ADR-009); D049 and D071 share a name, so the name is not unique.
CREATE TABLE defects (
  id           text        PRIMARY KEY CHECK (id ~ '^D[0-9]{3}$'),
  name         text        NOT NULL,
  severity     text        NOT NULL CHECK (severity IN ('MINOR', 'MAJOR', 'CRITICAL')),
  ctq_category text,
  ctq_code     text,
  active       boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- §3.5. The shoe-map pills are bound to the area ids A01–A12.
CREATE TABLE areas (
  id         text        PRIMARY KEY CHECK (id ~ '^A(0[1-9]|1[0-2])$'),
  name       text        NOT NULL,
  sort       integer     NOT NULL,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sub_areas (
  id         text        PRIMARY KEY,
  area_id    text        NOT NULL REFERENCES areas (id) ON DELETE RESTRICT,
  name       text        NOT NULL,
  sort       integer     NOT NULL,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Target of the composite key in area_map: a map row's sub-area must belong to the row's area.
  UNIQUE (id, area_id)
);

CREATE INDEX sub_areas_area_id_idx ON sub_areas (area_id);

CREATE TABLE families (
  id         text        PRIMARY KEY,
  name       text        NOT NULL,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Name and severity of a defect live only in defects (doc 02 §3.5).
CREATE TABLE area_map (
  id          text        PRIMARY KEY,
  area_id     text        NOT NULL REFERENCES areas (id) ON DELETE RESTRICT,
  sub_area_id text        NOT NULL,
  family_id   text        NOT NULL REFERENCES families (id) ON DELETE RESTRICT,
  defect_id   text        NOT NULL REFERENCES defects (id) ON DELETE RESTRICT,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sub_area_id, family_id, defect_id),
  FOREIGN KEY (sub_area_id, area_id) REFERENCES sub_areas (id, area_id) ON DELETE RESTRICT
);

CREATE INDEX area_map_area_id_idx ON area_map (area_id);
CREATE INDEX area_map_family_id_idx ON area_map (family_id);
CREATE INDEX area_map_defect_id_idx ON area_map (defect_id);
