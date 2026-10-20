-- Grants for the runtime and reporting roles (doc 03 §6). The roles themselves are created once by db:bootstrap;
-- m100_migrate owns the database and every object in it. A later migration that adds a table or view grants it here
-- in the same style, because nothing is granted by default.

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO m100_app, m100_report;

-- m100_app, the API and the server CLIs. Master data is deactivated, never deleted, so no DELETE anywhere.
GRANT SELECT, INSERT, UPDATE ON
  psi_users, factories, cells, pos, defects, areas, sub_areas, families, area_map
  TO m100_app;

-- Submissions are written once and never changed (BR-07); the trigger also blocks UPDATE and DELETE.
GRANT SELECT, INSERT ON submissions, submission_findings, submission_photos TO m100_app;

GRANT SELECT, INSERT, UPDATE ON devices, admins TO m100_app;
GRANT SELECT, INSERT ON audit_log TO m100_app;
GRANT SELECT, UPDATE ON settings TO m100_app;

-- The admin app's list and CSV export read the views; the readiness check DB reads the applied versions.
GRANT SELECT ON v_submissions, v_findings, v_defect_totals, v_top5 TO m100_app;
GRANT SELECT ON schema_migrations TO m100_app;

-- m100_report, for reporting tools: the views and nothing else (doc 02 §8). Views run with their owner's rights,
-- so no base table is granted.
GRANT SELECT ON v_submissions, v_findings, v_defect_totals, v_top5 TO m100_report;
