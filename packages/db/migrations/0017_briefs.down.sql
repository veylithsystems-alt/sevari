DELETE FROM owner_reports WHERE kind IN ('morning', 'evening');
ALTER TABLE owner_reports DROP CONSTRAINT owner_reports_kind_check;
ALTER TABLE owner_reports ADD CONSTRAINT owner_reports_kind_check CHECK (kind IN ('weekly'));
