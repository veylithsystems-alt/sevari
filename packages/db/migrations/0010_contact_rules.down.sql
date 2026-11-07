DROP TRIGGER IF EXISTS outbox_purpose_check ON outbox;
DROP FUNCTION IF EXISTS sevari_meta.outbox_purpose_check();
DROP FUNCTION IF EXISTS sevari_meta.contact_tier(uuid, uuid);
DROP INDEX IF EXISTS outbox_contact_recent;
CREATE OR REPLACE VIEW metrics_floor_suppressed_sends WITH (security_invoker = true) AS
SELECT o.tenant_id, o.region, o.id AS outbox_id, o.sent_at
  FROM outbox o JOIN suppressions s ON s.tenant_id = o.tenant_id AND s.recipient_bidx = o.recipient_bidx AND s.channel_scope IN (o.channel, 'all')
 WHERE o.state = 'sent' AND s.created_at < o.sent_at;
ALTER TABLE outbox DROP COLUMN IF EXISTS dispatched_at;
ALTER TABLE outbox DROP COLUMN IF EXISTS not_before;
ALTER TABLE outbox DROP COLUMN IF EXISTS initiative;
DROP TABLE IF EXISTS purpose_rules;
DROP TABLE IF EXISTS lead_sources;
ALTER TABLE regions DROP COLUMN IF EXISTS contact_rules;
