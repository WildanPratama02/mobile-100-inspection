-- Reporting views (doc 02 §8), read by the admin app and by m100_report. Times are shown in WIB explicitly, so the
-- result does not depend on the session time zone. counting_rule tells these rows apart from the old AppSheet rows,
-- which counted A-Grade differently (doc 02 §9).

-- Integer with Indonesian thousands separators: 10002 -> '10.002'.
CREATE FUNCTION format_id_integer(n bigint) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN replace(to_char(n, 'FM9,999,999,999,999,999'), ',', '.');

CREATE VIEW v_submissions AS
SELECT
  s.id,
  s.display_no,
  s.inspection_date,
  s.sealed_at AT TIME ZONE 'Asia/Jakarta' AS sealed_at,
  s.username,
  s.level,
  s.factory,
  s.cell,
  s.po,
  s.article,
  s.model,
  s.destination,
  s.order_qty,
  s.podd,
  s.crd,
  s.partial_no,
  s.partial_qty,
  -- The sheet's display value P1 1.200 OF 10.002 (doc 02 §4.1); null when the PO is not partial.
  CASE
    WHEN s.partial_no IS NOT NULL THEN
      'P' || s.partial_no || ' ' || format_id_integer(s.partial_qty) || ' OF ' || format_id_integer(s.order_qty)
  END AS partial_text,
  s.qty_rework,
  s.qty_bgrade_inspections,
  s.qty_no_defect,
  s.qty_inspection,
  s.qty_a_grade,
  s.qty_b_grade,
  s.qty_defect,
  s.rft,
  s.defect_rate,
  s.photo_count,
  'ADR-008'::text AS counting_rule
FROM submissions s;

CREATE VIEW v_findings AS
SELECT
  f.submission_id,
  s.display_no,
  s.inspection_date,
  s.username,
  s.level,
  s.factory,
  s.cell,
  s.po,
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
  'ADR-008'::text AS counting_rule
FROM submission_findings f
JOIN submissions s ON s.id = f.submission_id
JOIN areas a ON a.id = f.area_id
JOIN sub_areas sa ON sa.id = f.sub_area_id
JOIN families fam ON fam.id = f.family_id;

-- One row per submission and defect, summed over areas, sub-areas and inspection types, ranked in the Top 5 order
-- (AC-05.1): quantity, then CRITICAL > MAJOR > MINOR, then first recorded. This is the order of rankDefects() in
-- packages/shared; defect_id only settles a tie that the tablet cannot produce (two defects with the same instant).
CREATE VIEW v_defect_totals AS
WITH totals AS (
  SELECT
    f.submission_id,
    f.defect_id,
    min(f.defect_name) AS defect_name,
    min(f.severity) AS severity,
    sum(f.qty)::integer AS qty,
    min(f.first_recorded_at) AS first_recorded_at
  FROM submission_findings f
  GROUP BY f.submission_id, f.defect_id
)
SELECT
  t.submission_id,
  s.display_no,
  s.inspection_date,
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
    SELECT 1 FROM submission_photos p WHERE p.submission_id = t.submission_id AND p.defect_id = t.defect_id
  ) AS has_photo,
  'ADR-008'::text AS counting_rule
FROM totals t
JOIN submissions s ON s.id = t.submission_id;

CREATE VIEW v_top5 AS
SELECT *
FROM v_defect_totals
WHERE rank_in_submission <= 5;
