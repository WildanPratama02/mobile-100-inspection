-- Submissions (doc 02 §4). One submissions row is one Submit PO (ADR-003); written once by the API (doc 02 §6) and
-- never updated or deleted (BR-07, ADR-018). Text copied from master tables is a snapshot, so these tables have no
-- foreign key to psi_users or pos.

CREATE TABLE submissions (
  id                     uuid          PRIMARY KEY,
  display_no             bigint        GENERATED ALWAYS AS IDENTITY UNIQUE,
  payload_sha256         bytea         NOT NULL CHECK (octet_length(payload_sha256) = 32),
  sealed_at              timestamptz   NOT NULL,
  received_at            timestamptz   NOT NULL DEFAULT now(),
  inspection_date        date          NOT NULL,
  app_version            text,
  device_id              uuid          REFERENCES devices (id) ON DELETE RESTRICT,
  username               text          NOT NULL,
  level                  text          NOT NULL CHECK (level IN ('PSI lv.1', 'PSI lv.2')),
  factory                text          NOT NULL,
  cell                   text          NOT NULL,
  po                     text          NOT NULL,
  article                text          NOT NULL,
  model                  text          NOT NULL,
  destination            text          NOT NULL,
  order_qty              integer       NOT NULL CHECK (order_qty >= 1),
  podd                   date,
  crd                    date,
  partial_no             smallint      CHECK (partial_no BETWEEN 1 AND 99),
  partial_qty            integer,
  qty_rework             integer       NOT NULL CHECK (qty_rework >= 0),
  qty_bgrade_inspections integer       NOT NULL CHECK (qty_bgrade_inspections >= 0),
  qty_no_defect          integer       NOT NULL CHECK (qty_no_defect >= 0),
  qty_inspection         integer       NOT NULL CHECK (qty_inspection >= 1),
  qty_a_grade            integer       NOT NULL,
  qty_b_grade            integer       NOT NULL CHECK (qty_b_grade >= 0),
  qty_defect             integer       NOT NULL CHECK (qty_defect >= 0),
  rft                    numeric(8, 5) NOT NULL CHECK (rft >= 0),
  defect_rate            numeric(8, 5) NOT NULL CHECK (defect_rate >= 0),
  photo_count            smallint      NOT NULL CHECK (photo_count >= 0),
  -- Totals must agree with the counts (doc 02 §4.1, ADR-008), so a bug in the API cannot store inconsistent numbers.
  CONSTRAINT submissions_qty_inspection_sum_check
    CHECK (qty_inspection = qty_rework + qty_bgrade_inspections + qty_no_defect),
  CONSTRAINT submissions_qty_a_grade_check CHECK (qty_a_grade = qty_no_defect),
  CONSTRAINT submissions_qty_b_grade_le_defect_check CHECK (qty_b_grade <= qty_defect),
  -- ADR-013: both null (not partial) or both set, with 1 <= partial_qty <= order_qty.
  CONSTRAINT submissions_partial_check CHECK (
    (partial_no IS NULL AND partial_qty IS NULL)
    OR (partial_no IS NOT NULL AND partial_qty IS NOT NULL AND partial_qty BETWEEN 1 AND order_qty)
  )
);

CREATE INDEX submissions_inspection_date_idx ON submissions (inspection_date);
CREATE INDEX submissions_po_idx ON submissions (po);
CREATE INDEX submissions_device_id_idx ON submissions (device_id);

-- One row per inspection type + area + sub-area + defect (doc 02 §4.2).
CREATE TABLE submission_findings (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id     uuid        NOT NULL REFERENCES submissions (id) ON DELETE RESTRICT,
  inspection_type   text        NOT NULL CHECK (inspection_type IN ('REWORK', 'B-GRADE')),
  area_id           text        NOT NULL REFERENCES areas (id) ON DELETE RESTRICT,
  sub_area_id       text        NOT NULL REFERENCES sub_areas (id) ON DELETE RESTRICT,
  family_id         text        NOT NULL REFERENCES families (id) ON DELETE RESTRICT,
  defect_id         text        NOT NULL REFERENCES defects (id) ON DELETE RESTRICT,
  defect_name       text        NOT NULL,
  severity          text        NOT NULL CHECK (severity IN ('MINOR', 'MAJOR', 'CRITICAL')),
  qty               integer     NOT NULL CHECK (qty >= 1),
  first_recorded_at timestamptz NOT NULL,
  UNIQUE (submission_id, inspection_type, area_id, sub_area_id, defect_id)
);

CREATE INDEX submission_findings_defect_id_idx ON submission_findings (defect_id);
CREATE INDEX submission_findings_area_id_idx ON submission_findings (area_id);

-- At most one photo per defect (AC-10.5); key submissions/<yyyy>/<MM>/<uuid>/<defectId>.jpg (doc 02 §7).
CREATE TABLE submission_photos (
  id            bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id uuid    NOT NULL REFERENCES submissions (id) ON DELETE RESTRICT,
  defect_id     text    NOT NULL REFERENCES defects (id) ON DELETE RESTRICT,
  object_key    text    NOT NULL UNIQUE,
  sha256        bytea   NOT NULL CHECK (octet_length(sha256) = 32),
  size_bytes    integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
  UNIQUE (submission_id, defect_id)
);

-- Immutability (doc 02 §4.1, Q4). Applies to every role, the owner included; there is no void in release 1.
CREATE FUNCTION reject_submission_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: submissions are immutable (BR-07)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER submissions_immutable
  BEFORE UPDATE OR DELETE ON submissions
  FOR EACH ROW EXECUTE FUNCTION reject_submission_change();
CREATE TRIGGER submissions_no_truncate
  BEFORE TRUNCATE ON submissions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_submission_change();

CREATE TRIGGER submission_findings_immutable
  BEFORE UPDATE OR DELETE ON submission_findings
  FOR EACH ROW EXECUTE FUNCTION reject_submission_change();
CREATE TRIGGER submission_findings_no_truncate
  BEFORE TRUNCATE ON submission_findings
  FOR EACH STATEMENT EXECUTE FUNCTION reject_submission_change();

CREATE TRIGGER submission_photos_immutable
  BEFORE UPDATE OR DELETE ON submission_photos
  FOR EACH ROW EXECUTE FUNCTION reject_submission_change();
CREATE TRIGGER submission_photos_no_truncate
  BEFORE TRUNCATE ON submission_photos
  FOR EACH STATEMENT EXECUTE FUNCTION reject_submission_change();
