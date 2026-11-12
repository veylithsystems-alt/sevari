-- 0017 owner briefs (§78): a morning brief (07:00) and an evening summary (19:00), business-local time.
-- Stored like the weekly report: counts in `metrics`, the lines themselves (which can name a customer's
-- question) encrypted in `body_enc`, each line carrying the audit events behind it (A5).
ALTER TABLE owner_reports DROP CONSTRAINT owner_reports_kind_check;
ALTER TABLE owner_reports ADD CONSTRAINT owner_reports_kind_check CHECK (kind IN ('weekly', 'morning', 'evening'));
