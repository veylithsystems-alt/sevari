-- 0010 contact rules (Part B §17, Phase 10): who may be messaged, for what, when and how often.
-- The code gate (packages/outbound/src/policy.ts) decides and records the reason; this migration makes
-- the rules data and puts a database backstop under the most important one (purpose limitation).

------------------------------------------------------------------------------------------------
-- The cell's contact rules, as data (§17.3: a region's rules are a rule pack, not code). Written by the
-- owner role from config/regions/<code>.yaml (scripts/sync-region.ts); the boot check refuses a cell whose
-- database copy differs from its configuration. The default is the UK pack.
------------------------------------------------------------------------------------------------
ALTER TABLE regions ADD COLUMN contact_rules jsonb NOT NULL DEFAULT '{
  "timezone": "Europe/London",
  "sending_window": { "start": "07:30", "end": "21:30" },
  "tiers_enabled": ["A", "B"],
  "treat_as_individual": ["unknown", "individual", "sole_trader", "partnership"],
  "preference_registers": ["TPS", "CTPS"],
  "caps": { "proactive_per_7_days": 3, "marketing_per_30_days": 4, "responses_per_hour": 10 }
}'::jsonb;

------------------------------------------------------------------------------------------------
-- Lead sources (§17.1). Inbound channels (Tier A) are built in; every other source is registered here.
-- Tier F (purchased lists) can't exist; Tiers C-E can't be switched on without counsel's sign-off.
------------------------------------------------------------------------------------------------
CREATE TABLE lead_sources (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  region               region_code NOT NULL,
  key                  text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*:[a-z0-9_.-]+$' AND key NOT LIKE 'channel:%'),
  tier                 text NOT NULL CHECK (tier IN ('A', 'B', 'C', 'D', 'E')),
  type                 text NOT NULL,
  lawful_basis         text NOT NULL,
  data_categories      text[] NOT NULL CHECK (cardinality(data_categories) > 0),
  acquired_from        text NOT NULL,
  art14_notice_method  text,
  retention_days       integer NOT NULL CHECK (retention_days > 0),
  counsel_signoff      jsonb,
  enabled              boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  version              integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, key),
  CHECK (tier NOT IN ('C', 'D', 'E') OR NOT enabled OR counsel_signoff IS NOT NULL),
  -- Discovered from public data (E): the person must be told within a month (Art. 14), so say how.
  CHECK (tier <> 'E' OR art14_notice_method IS NOT NULL)
);
CREATE TRIGGER lead_sources_touch BEFORE UPDATE ON lead_sources FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('lead_sources', 'SELECT, INSERT');
GRANT UPDATE (enabled, counsel_signoff, retention_days, art14_notice_method) ON lead_sources TO sevari_app;

------------------------------------------------------------------------------------------------
-- Purpose limitation (§17.2): what a contact from each tier may be sent. 'consent' means only with a
-- current consent-ledger grant for that purpose and channel. Cell-wide data, no personal data.
------------------------------------------------------------------------------------------------
CREATE TABLE purpose_rules (
  tier       text NOT NULL CHECK (tier IN ('A', 'B', 'C', 'D', 'E')),
  purpose    text NOT NULL CHECK (purpose IN ('ack', 'safety', 'holding', 'clarify', 'reply', 'marketing')),
  rule       text NOT NULL CHECK (rule IN ('allowed', 'consent', 'never')),
  note       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version    integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tier, purpose)
);
ALTER TABLE purpose_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE purpose_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY purpose_rules_read ON purpose_rules FOR SELECT TO sevari_app USING (true);
CREATE POLICY purpose_rules_admin ON purpose_rules FOR ALL TO sevari_owner USING (true) WITH CHECK (true);
GRANT SELECT ON purpose_rules TO sevari_app;
INSERT INTO purpose_rules (tier, purpose, rule, note) VALUES
  ('A', 'ack',       'allowed', 'they contacted the business; acknowledging is part of answering'),
  ('A', 'safety',    'allowed', 'risk to life'),
  ('A', 'holding',   'allowed', 'answering their enquiry'),
  ('A', 'clarify',   'allowed', 'answering their enquiry'),
  ('A', 'reply',     'allowed', 'answering their enquiry and the service they asked for'),
  ('A', 'marketing', 'consent', 'an enquiry is not consent to marketing'),
  ('B', 'ack',       'allowed', 'confirming their opt-in'),
  ('B', 'safety',    'allowed', 'risk to life'),
  ('B', 'holding',   'never',   'nothing to hold: they did not ask a question'),
  ('B', 'clarify',   'never',   'nothing to clarify'),
  ('B', 'reply',     'consent', 'only what they opted in to'),
  ('B', 'marketing', 'consent', 'only with a current grant for this purpose and channel'),
  ('C', 'ack',       'never',   'they did not contact us'),
  ('C', 'safety',    'never',   'not applicable'),
  ('C', 'holding',   'never',   'not applicable'),
  ('C', 'clarify',   'never',   'not applicable'),
  ('C', 'reply',     'never',   'not applicable'),
  ('C', 'marketing', 'allowed', 'corporate subscribers only, under a legitimate interest assessment; checked by the policy gate'),
  ('D', 'ack',       'never',   'they did not contact us'),
  ('D', 'safety',    'never',   'not applicable'),
  ('D', 'holding',   'never',   'not applicable'),
  ('D', 'clarify',   'never',   'not applicable'),
  ('D', 'reply',     'never',   'not applicable'),
  ('D', 'marketing', 'consent', 'sole traders and partnerships: consent only (PECR treats them as individuals)'),
  ('E', 'ack',       'never',   'they did not contact us'),
  ('E', 'safety',    'never',   'not applicable'),
  ('E', 'holding',   'never',   'not applicable'),
  ('E', 'clarify',   'never',   'not applicable'),
  ('E', 'reply',     'never',   'not applicable'),
  ('E', 'marketing', 'consent', 'discovered from public data: consent only, after the Art. 14 notice');

------------------------------------------------------------------------------------------------
-- Outbox: whether a message answers the person or starts something (quiet hours and caps apply to the
-- latter), and the earliest time it may go.
------------------------------------------------------------------------------------------------
ALTER TABLE outbox ADD COLUMN initiative text NOT NULL DEFAULT 'response' CHECK (initiative IN ('response', 'proactive'));
ALTER TABLE outbox ADD COLUMN not_before timestamptz;
-- When the send was handed to the provider (dispatch claimed it, under the recipient lock). An opt-out
-- that commits after this can't recall a message already on its way; one that commits before always wins.
ALTER TABLE outbox ADD COLUMN dispatched_at timestamptz;
GRANT UPDATE (dispatched_at) ON outbox TO sevari_app;
CREATE OR REPLACE VIEW metrics_floor_suppressed_sends WITH (security_invoker = true) AS
SELECT o.tenant_id, o.region, o.id AS outbox_id, o.sent_at
  FROM outbox o JOIN suppressions s ON s.tenant_id = o.tenant_id AND s.recipient_bidx = o.recipient_bidx AND s.channel_scope IN (o.channel, 'all')
 WHERE o.state = 'sent' AND s.created_at < COALESCE(o.dispatched_at, o.sent_at);
CREATE INDEX outbox_contact_recent ON outbox (tenant_id, contact_id, reserved_at) WHERE state IN ('reserved', 'sending', 'sent', 'ambiguous');

-- The tier a contact came from: inbound channels are A; anything else must be a registered, enabled source.
CREATE FUNCTION sevari_meta.contact_tier(p_tenant uuid, p_contact uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN c.source LIKE 'channel:%' THEN 'A'
              ELSE (SELECT s.tier FROM lead_sources s WHERE s.tenant_id = c.tenant_id AND s.key = c.source AND s.enabled) END
    FROM contacts c WHERE c.tenant_id = p_tenant AND c.id = p_contact
$$;

-- Database backstop for purpose limitation (§17.2): an outbound message that will actually be attempted
-- must be allowed for the contact's tier, and where the rule is 'consent', backed by a current grant.
CREATE FUNCTION sevari_meta.outbox_purpose_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_tier text;
  v_rule text;
  v_action text;
BEGIN
  IF NEW.state = 'blocked' THEN RETURN NEW; END IF;
  v_tier := sevari_meta.contact_tier(NEW.tenant_id, NEW.contact_id);
  IF v_tier IS NULL THEN
    RAISE EXCEPTION 'contact % has no known, enabled source: it cannot be messaged (§17.2 provenance)', NEW.contact_id USING ERRCODE = 'check_violation';
  END IF;
  SELECT rule INTO v_rule FROM purpose_rules WHERE tier = v_tier AND purpose = NEW.purpose;
  IF v_rule IS NULL OR v_rule = 'never' THEN
    RAISE EXCEPTION 'purpose % is not allowed for a Tier % contact (§17.2 purpose limitation)', NEW.purpose, v_tier USING ERRCODE = 'check_violation';
  END IF;
  IF v_rule = 'consent' THEN
    SELECT action INTO v_action FROM consents
     WHERE tenant_id = NEW.tenant_id AND contact_id = NEW.contact_id AND purpose = 'marketing' AND channel IN (NEW.channel, 'all')
     ORDER BY recorded_at DESC, created_at DESC LIMIT 1;
    IF v_action IS DISTINCT FROM 'granted' THEN
      RAISE EXCEPTION 'purpose % needs a current consent for % (§17.2)', NEW.purpose, NEW.channel USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_purpose_check BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION sevari_meta.outbox_purpose_check();
