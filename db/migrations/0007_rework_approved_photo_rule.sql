-- ADR-022: Rework and Approved (BR-11) and the photo rule of each new submission. Existing rows keep both columns
-- NULL: no backfill and no UPDATE (ADR-022 decision 4, amended 30 Oct 2026). The immutability trigger and the
-- grants stay as they are; the new columns are covered by both like every other submission column.
ALTER TABLE submissions
  ADD COLUMN qty_rework_approved integer NULL,
  ADD COLUMN photo_rule text NULL;
ALTER TABLE submissions
  ADD CONSTRAINT submissions_qty_rework_approved_check CHECK (
    qty_rework_approved IS NULL OR (qty_rework_approved >= 0 AND qty_rework_approved <= qty_rework)
  ),
  ADD CONSTRAINT submissions_photo_rule_check CHECK (
    photo_rule IS NULL OR (level = 'PSI lv.2' AND photo_rule IN ('TOP5', 'ALL'))
  );

-- Replace the view in place to retain ownership, grants and dependent reporting views; new columns go at the end.
CREATE OR REPLACE VIEW v_submissions AS
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
  s.counting_rule,
  s.qty_rework_approved,
  s.photo_rule
FROM submissions s;
