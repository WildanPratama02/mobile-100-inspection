-- ADR-024: admin corrections of a submission (doc 02 §4.4, §6.5, §8). A correction is a revision: a complete new
-- version of the correctable fields, findings and photos. The original rows in submissions, submission_findings
-- and submission_photos are never changed; the revisions are as immutable as they are. The reporting views show
-- the effective version (the newest revision, or the original), with their existing columns unchanged.

CREATE TABLE submission_revisions (
  id                     uuid          PRIMARY KEY,
  submission_id          uuid          NOT NULL REFERENCES submissions (id) ON DELETE RESTRICT,
  revision_no            integer       NOT NULL CHECK (revision_no >= 1),
  request_sha256         bytea         NOT NULL CHECK (octet_length(request_sha256) = 32),
  created_at             timestamptz   NOT NULL DEFAULT now(),
  admin_id               integer       NOT NULL REFERENCES admins (id) ON DELETE RESTRICT,
  admin_username         text          NOT NULL,
  reason                 text          NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500),
  sealed_at              timestamptz   NOT NULL,
  inspection_date        date          NOT NULL,
  username               text          NOT NULL,
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
  -- A revision always states Rework and Approved (0 when empty), BR-11.
  qty_rework_approved    integer       NOT NULL,
  qty_no_defect          integer       CHECK (qty_no_defect >= 0),
  qty_inspection         integer       NOT NULL CHECK (qty_inspection >= 1),
  qty_a_grade            integer       NOT NULL,
  qty_b_grade            integer       NOT NULL CHECK (qty_b_grade >= 0),
  qty_defect             integer       NOT NULL CHECK (qty_defect >= 0),
  rft                    numeric(8, 5) NOT NULL CHECK (rft >= 0),
  defect_rate            numeric(8, 5) NOT NULL CHECK (defect_rate >= 0),
  photo_count            smallint      NOT NULL CHECK (photo_count >= 0),
  changes                jsonb         NOT NULL,
  UNIQUE (submission_id, revision_no),
  CONSTRAINT submission_revisions_qty_rework_approved_check
    CHECK (qty_rework_approved >= 0 AND qty_rework_approved <= qty_rework),
  CONSTRAINT submission_revisions_qty_b_grade_le_defect_check CHECK (qty_b_grade <= qty_defect),
  CONSTRAINT submission_revisions_partial_check CHECK (
    (partial_no IS NULL AND partial_qty IS NULL)
    OR (partial_no IS NOT NULL AND partial_qty IS NOT NULL AND partial_qty BETWEEN 1 AND order_qty)
  )
);

-- Same columns as submission_findings, per revision.
CREATE TABLE submission_revision_findings (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  revision_id       uuid        NOT NULL REFERENCES submission_revisions (id) ON DELETE RESTRICT,
  inspection_type   text        NOT NULL CHECK (inspection_type IN ('REWORK', 'B-GRADE')),
  area_id           text        NOT NULL REFERENCES areas (id) ON DELETE RESTRICT,
  sub_area_id       text        NOT NULL REFERENCES sub_areas (id) ON DELETE RESTRICT,
  family_id         text        NOT NULL REFERENCES families (id) ON DELETE RESTRICT,
  defect_id         text        NOT NULL REFERENCES defects (id) ON DELETE RESTRICT,
  defect_name       text        NOT NULL,
  severity          text        NOT NULL CHECK (severity IN ('MINOR', 'MAJOR', 'CRITICAL')),
  qty               integer     NOT NULL CHECK (qty >= 1),
  first_recorded_at timestamptz NOT NULL,
  UNIQUE (revision_id, inspection_type, area_id, sub_area_id, defect_id)
);

CREATE INDEX submission_revision_findings_defect_id_idx ON submission_revision_findings (defect_id);

-- Same columns as submission_photos, per revision. object_key is not unique: a kept photo points to the object of
-- an earlier version (doc 02 §4.4). A new photo's key is submissions/<yyyy>/<MM>/<uuid>/r<n>/<defectId>.jpg.
CREATE TABLE submission_revision_photos (
  id            bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  revision_id   uuid    NOT NULL REFERENCES submission_revisions (id) ON DELETE RESTRICT,
  defect_id     text    NOT NULL REFERENCES defects (id) ON DELETE RESTRICT,
  object_key    text    NOT NULL,
  sha256        bytea   NOT NULL CHECK (octet_length(sha256) = 32),
  size_bytes    integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
  UNIQUE (revision_id, defect_id)
);

CREATE INDEX submission_revision_photos_object_key_idx ON submission_revision_photos (object_key);

-- Immutability (BR-07, ADR-024): the trigger of the original tables.
CREATE TRIGGER submission_revisions_immutable
  BEFORE UPDATE OR DELETE ON submission_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_submission_change();
CREATE TRIGGER submission_revisions_no_truncate
  BEFORE TRUNCATE ON submission_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_submission_change();
CREATE TRIGGER submission_revision_findings_immutable
  BEFORE UPDATE OR DELETE ON submission_revision_findings
  FOR EACH ROW EXECUTE FUNCTION reject_submission_change();
CREATE TRIGGER submission_revision_findings_no_truncate
  BEFORE TRUNCATE ON submission_revision_findings
  FOR EACH STATEMENT EXECUTE FUNCTION reject_submission_change();
CREATE TRIGGER submission_revision_photos_immutable
  BEFORE UPDATE OR DELETE ON submission_revision_photos
  FOR EACH ROW EXECUTE FUNCTION reject_submission_change();
CREATE TRIGGER submission_revision_photos_no_truncate
  BEFORE TRUNCATE ON submission_revision_photos
  FOR EACH STATEMENT EXECUTE FUNCTION reject_submission_change();

-- The totals of a revision follow the counting rule of its original (doc 02 §4.1), which a CHECK cannot read.
CREATE FUNCTION check_submission_revision_rule() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  rule text;
BEGIN
  SELECT counting_rule INTO rule FROM submissions WHERE id = NEW.submission_id;
  IF rule = 'ADR-008' THEN
    IF NEW.qty_no_defect IS NULL
       OR NEW.qty_inspection <> NEW.qty_rework + NEW.qty_bgrade_inspections + NEW.qty_no_defect
       OR NEW.qty_a_grade <> NEW.qty_no_defect THEN
      RAISE EXCEPTION 'revision totals do not follow ADR-008' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'submission_revisions_rule_check';
    END IF;
  ELSIF rule = 'ADR-019' THEN
    IF NEW.qty_no_defect IS NOT NULL
       OR NEW.qty_inspection < NEW.qty_defect
       OR NEW.qty_a_grade <> NEW.qty_inspection - NEW.qty_defect
       OR NEW.qty_inspection > COALESCE(NEW.partial_qty, NEW.order_qty) THEN
      RAISE EXCEPTION 'revision totals do not follow ADR-019' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'submission_revisions_rule_check';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER submission_revisions_rule_check
  AFTER INSERT ON submission_revisions
  FOR EACH ROW EXECUTE FUNCTION check_submission_revision_rule();

-- The effective version of every submission: its newest revision, or the original (doc 02 §4.4). Internal: read by
-- the API, not granted to m100_report, which reads the reporting views below.
CREATE VIEW v_effective_submissions AS
SELECT
  s.id,
  s.display_no,
  s.payload_sha256,
  s.received_at,
  s.app_version,
  s.device_id,
  s.level,
  s.counting_rule,
  s.photo_rule,
  s.username AS original_username,
  COALESCE(r.revision_no, 0) AS revision_no,
  r.id AS revision_id,
  r.created_at AS corrected_at,
  r.admin_username AS corrected_by,
  r.reason AS correction_reason,
  CASE WHEN r.id IS NULL THEN s.sealed_at ELSE r.sealed_at END AS sealed_at,
  CASE WHEN r.id IS NULL THEN s.inspection_date ELSE r.inspection_date END AS inspection_date,
  CASE WHEN r.id IS NULL THEN s.username ELSE r.username END AS username,
  CASE WHEN r.id IS NULL THEN s.factory ELSE r.factory END AS factory,
  CASE WHEN r.id IS NULL THEN s.cell ELSE r.cell END AS cell,
  CASE WHEN r.id IS NULL THEN s.po ELSE r.po END AS po,
  CASE WHEN r.id IS NULL THEN s.article ELSE r.article END AS article,
  CASE WHEN r.id IS NULL THEN s.model ELSE r.model END AS model,
  CASE WHEN r.id IS NULL THEN s.destination ELSE r.destination END AS destination,
  CASE WHEN r.id IS NULL THEN s.order_qty ELSE r.order_qty END AS order_qty,
  CASE WHEN r.id IS NULL THEN s.podd ELSE r.podd END AS podd,
  CASE WHEN r.id IS NULL THEN s.crd ELSE r.crd END AS crd,
  CASE WHEN r.id IS NULL THEN s.partial_no ELSE r.partial_no END AS partial_no,
  CASE WHEN r.id IS NULL THEN s.partial_qty ELSE r.partial_qty END AS partial_qty,
  CASE WHEN r.id IS NULL THEN s.qty_rework ELSE r.qty_rework END AS qty_rework,
  CASE WHEN r.id IS NULL THEN s.qty_bgrade_inspections ELSE r.qty_bgrade_inspections END AS qty_bgrade_inspections,
  CASE WHEN r.id IS NULL THEN s.qty_rework_approved ELSE r.qty_rework_approved END AS qty_rework_approved,
  CASE WHEN r.id IS NULL THEN s.qty_no_defect ELSE r.qty_no_defect END AS qty_no_defect,
  CASE WHEN r.id IS NULL THEN s.qty_inspection ELSE r.qty_inspection END AS qty_inspection,
  CASE WHEN r.id IS NULL THEN s.qty_a_grade ELSE r.qty_a_grade END AS qty_a_grade,
  CASE WHEN r.id IS NULL THEN s.qty_b_grade ELSE r.qty_b_grade END AS qty_b_grade,
  CASE WHEN r.id IS NULL THEN s.qty_defect ELSE r.qty_defect END AS qty_defect,
  CASE WHEN r.id IS NULL THEN s.rft ELSE r.rft END AS rft,
  CASE WHEN r.id IS NULL THEN s.defect_rate ELSE r.defect_rate END AS defect_rate,
  CASE WHEN r.id IS NULL THEN s.photo_count ELSE r.photo_count END AS photo_count
FROM submissions s
LEFT JOIN LATERAL (
  SELECT * FROM submission_revisions x
   WHERE x.submission_id = s.id
   ORDER BY x.revision_no DESC
   LIMIT 1
) r ON true;

-- The findings of the effective version.
CREATE VIEW v_effective_findings AS
SELECT e.id AS submission_id, e.revision_no, f.id AS finding_id, f.inspection_type, f.area_id, f.sub_area_id,
       f.family_id, f.defect_id, f.defect_name, f.severity, f.qty, f.first_recorded_at
  FROM v_effective_submissions e
  JOIN submission_findings f ON f.submission_id = e.id
 WHERE e.revision_id IS NULL
UNION ALL
SELECT e.id, e.revision_no, f.id, f.inspection_type, f.area_id, f.sub_area_id,
       f.family_id, f.defect_id, f.defect_name, f.severity, f.qty, f.first_recorded_at
  FROM v_effective_submissions e
  JOIN submission_revision_findings f ON f.revision_id = e.revision_id;

-- The photos of the effective version; `source` says which table `photo_id` belongs to.
CREATE VIEW v_effective_photos AS
SELECT e.id AS submission_id, e.revision_no, 'original'::text AS source, p.id AS photo_id, p.defect_id,
       p.object_key, p.sha256, p.size_bytes
  FROM v_effective_submissions e
  JOIN submission_photos p ON p.submission_id = e.id
 WHERE e.revision_id IS NULL
UNION ALL
SELECT e.id, e.revision_no, 'revision'::text, p.id, p.defect_id, p.object_key, p.sha256, p.size_bytes
  FROM v_effective_submissions e
  JOIN submission_revision_photos p ON p.revision_id = e.revision_id;

-- The reporting views, rebuilt in place on the effective version: existing columns keep their names, order and
-- types (ownership and grants stay); v_submissions gets four columns at the end.
CREATE OR REPLACE VIEW v_submissions AS
SELECT
  e.id,
  e.display_no,
  e.inspection_date,
  e.sealed_at AT TIME ZONE 'Asia/Jakarta' AS sealed_at,
  e.username,
  e.level,
  e.factory,
  e.cell,
  e.po,
  e.article,
  e.model,
  e.destination,
  e.order_qty,
  e.podd,
  e.crd,
  e.partial_no,
  e.partial_qty,
  -- The sheet's display value P1 1.200 OF 10.002 (doc 02 §4.1); null when the PO is not partial.
  CASE
    WHEN e.partial_no IS NOT NULL THEN
      'P' || e.partial_no || ' ' || format_id_integer(e.partial_qty) || ' OF ' || format_id_integer(e.order_qty)
  END AS partial_text,
  e.qty_rework,
  e.qty_bgrade_inspections,
  e.qty_no_defect,
  e.qty_inspection,
  e.qty_a_grade,
  e.qty_b_grade,
  e.qty_defect,
  e.rft,
  e.defect_rate,
  e.photo_count,
  e.counting_rule,
  e.qty_rework_approved,
  e.photo_rule,
  e.revision_no,
  e.corrected_at AT TIME ZONE 'Asia/Jakarta' AS corrected_at,
  e.corrected_by,
  e.correction_reason
FROM v_effective_submissions e;

CREATE OR REPLACE VIEW v_findings AS
SELECT
  f.submission_id,
  e.display_no,
  e.inspection_date,
  e.username,
  e.level,
  e.factory,
  e.cell,
  e.po,
  f.inspection_type,
  f.area_id,
  a.name AS area_name,
  f.sub_area_id,
  sa.name AS sub_area_name,
  f.family_id,
  fam.name AS family_name,
  f.defect_id,
  f.defect_name,
  f.severity,
  f.qty,
  f.first_recorded_at AT TIME ZONE 'Asia/Jakarta' AS first_recorded_at,
  e.counting_rule
FROM v_effective_findings f
JOIN v_effective_submissions e ON e.id = f.submission_id
JOIN areas a ON a.id = f.area_id
JOIN sub_areas sa ON sa.id = f.sub_area_id
JOIN families fam ON fam.id = f.family_id;

CREATE OR REPLACE VIEW v_defect_totals AS
WITH totals AS (
  SELECT
    f.submission_id,
    f.defect_id,
    min(f.defect_name) AS defect_name,
    min(f.severity) AS severity,
    sum(f.qty)::integer AS qty,
    min(f.first_recorded_at) AS first_recorded_at
  FROM v_effective_findings f
  GROUP BY f.submission_id, f.defect_id
)
SELECT
  t.submission_id,
  e.display_no,
  e.inspection_date,
  t.defect_id,
  t.defect_name,
  t.severity,
  t.qty,
  t.first_recorded_at AT TIME ZONE 'Asia/Jakarta' AS first_recorded_at,
  row_number() OVER (
    PARTITION BY t.submission_id
    ORDER BY
      t.qty DESC,
      CASE t.severity WHEN 'CRITICAL' THEN 0 WHEN 'MAJOR' THEN 1 ELSE 2 END,
      t.first_recorded_at,
      t.defect_id
  )::integer AS rank_in_submission,
  EXISTS (
    SELECT 1 FROM v_effective_photos p WHERE p.submission_id = t.submission_id AND p.defect_id = t.defect_id
  ) AS has_photo,
  e.counting_rule
FROM totals t
JOIN v_effective_submissions e ON e.id = t.submission_id;

-- v_top5 selects from v_defect_totals and follows it unchanged.

GRANT SELECT, INSERT ON submission_revisions, submission_revision_findings, submission_revision_photos TO m100_app;
GRANT SELECT ON v_effective_submissions, v_effective_findings, v_effective_photos TO m100_app;
