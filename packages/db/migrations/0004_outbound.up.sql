-- 0004 outbound: suppression ledger (minimal; Phase 10 completes §17.2), outbox with send intent and
-- outcome states (§5.2 outbox, Part J §66), reply records (§10.2).

------------------------------------------------------------------------------------------------
-- Suppressions: STOP and opt-outs take effect immediately and are checked inside the same
-- transaction that reserves a send (§17.2, F9 groundwork). Keyed by blind index, never plaintext.
------------------------------------------------------------------------------------------------
CREATE TABLE suppressions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  region            region_code NOT NULL,
  channel_scope     text NOT NULL CHECK (channel_scope IN ('sms', 'email', 'all')),
  recipient_bidx    bytea NOT NULL,
  reason            text NOT NULL CHECK (reason IN ('stop_keyword', 'opt_out_request', 'provider_block', 'owner', 'complaint')),
  source_ref        text,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  version           integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel_scope, recipient_bidx)
);
COMMENT ON COLUMN suppressions.recipient_bidx IS '@pii contact blind index of the suppressed phone or email';
SELECT sevari_meta.apply_tenant_rls('suppressions', 'SELECT, INSERT');

------------------------------------------------------------------------------------------------
-- Outbox: one row per intended send. States (Part J §66):
--   reserved  → intent recorded, nothing sent
--   sending   → provider call started (lease); a crash here is resolved by reconciliation
--   sent      → provider accepted; provider id recorded
--   ambiguous → outcome unknown (timeout/crash after call); reconcile before any retry
--   failed    → provider refused; never retried blindly
--   blocked   → suppressed or grounding failed at dispatch
-- Unique dedupe key per purpose: the same inbound message can never produce two ACKs.
------------------------------------------------------------------------------------------------
CREATE TABLE outbox (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  region              region_code NOT NULL,
  conversation_id     uuid NOT NULL,
  contact_id          uuid NOT NULL,
  in_reply_to         uuid,
  channel             text NOT NULL CHECK (channel IN ('email', 'sms', 'webform', 'api')),
  purpose             text NOT NULL CHECK (purpose IN ('ack', 'safety', 'holding', 'clarify', 'reply', 'marketing')),
  action_class        text NOT NULL,
  dedupe_key          text NOT NULL,
  recipient_enc       bytea NOT NULL,
  recipient_bidx      bytea NOT NULL,
  body_enc            bytea NOT NULL,
  body_digest         bytea NOT NULL,
  template_id         text,
  template_version    text,
  state               text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'sending', 'sent', 'ambiguous', 'failed', 'blocked')),
  attempts            integer NOT NULL DEFAULT 0,
  lease_until         timestamptz,
  provider            text,
  provider_message_id text,
  last_error          text,
  reserved_at         timestamptz NOT NULL,
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  version             integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, in_reply_to) REFERENCES messages (tenant_id, id) ON DELETE SET NULL (in_reply_to)
);
COMMENT ON COLUMN outbox.recipient_enc IS '@pii contact encrypted recipient address';
COMMENT ON COLUMN outbox.recipient_bidx IS '@pii contact blind index of recipient';
COMMENT ON COLUMN outbox.body_enc IS '@pii contact encrypted outbound message';
COMMENT ON COLUMN outbox.body_digest IS '@pii contact SHA-256 of the exact outbound bytes (approval digest, §7.1)';
CREATE INDEX outbox_pending ON outbox (tenant_id, state) WHERE state IN ('reserved', 'sending', 'ambiguous');
CREATE TRIGGER outbox_touch BEFORE UPDATE ON outbox FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
-- The body, recipient and digest can never change after reservation (approval digests bind to them).
CREATE FUNCTION sevari_meta.outbox_content_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body_enc IS DISTINCT FROM OLD.body_enc OR NEW.body_digest IS DISTINCT FROM OLD.body_digest
     OR NEW.recipient_enc IS DISTINCT FROM OLD.recipient_enc OR NEW.recipient_bidx IS DISTINCT FROM OLD.recipient_bidx
     OR NEW.channel IS DISTINCT FROM OLD.channel OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key THEN
    RAISE EXCEPTION 'outbox content is immutable after reservation (§7.1)' USING ERRCODE = 'check_violation';
  END IF;
  -- A sent message stays sent.
  IF OLD.state = 'sent' AND NEW.state <> 'sent' THEN
    RAISE EXCEPTION 'a sent message cannot change state' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_content_immutable BEFORE UPDATE ON outbox FOR EACH ROW EXECUTE FUNCTION sevari_meta.outbox_content_immutable();
SELECT sevari_meta.apply_tenant_rls('outbox', 'SELECT, INSERT');
GRANT UPDATE (state, attempts, lease_until, provider, provider_message_id, last_error, sent_at) ON outbox TO sevari_app;

------------------------------------------------------------------------------------------------
-- Reply records (§10.2): one per outbound or blocked draft. Codes and timings only, no content.
------------------------------------------------------------------------------------------------
CREATE TABLE reply_records (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  region             region_code NOT NULL,
  inbound_message_id uuid,
  enquiry_id         uuid,
  outbox_id          uuid,
  purpose            text NOT NULL,
  channel            text NOT NULL,
  intent             text,
  intent_confidence  numeric(4, 3),
  generator          text NOT NULL CHECK (generator IN ('template', 'model', 'human')),
  template_id        text,
  model_id           text,
  tokens             integer,
  facts_used         text[] NOT NULL DEFAULT '{}',
  facts_missing      text[] NOT NULL DEFAULT '{}',
  grounding_ok       boolean NOT NULL,
  grounding_failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  autonomy_decision  text NOT NULL,
  approval_outcome   text,
  edit_size          integer,
  edit_category      text,
  send_result        text NOT NULL,
  latency_ms         jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_minor         integer,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  version            integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, inbound_message_id) REFERENCES messages (tenant_id, id) ON DELETE SET NULL (inbound_message_id),
  FOREIGN KEY (tenant_id, outbox_id) REFERENCES outbox (tenant_id, id) ON DELETE SET NULL (outbox_id)
);
COMMENT ON COLUMN reply_records.grounding_failures IS 'rule codes and claim kinds only; never message content';
CREATE INDEX reply_records_metrics ON reply_records (tenant_id, created_at);
CREATE TRIGGER reply_records_touch BEFORE UPDATE ON reply_records FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('reply_records', 'SELECT, INSERT');
GRANT UPDATE (send_result, latency_ms, approval_outcome, edit_size, edit_category, cost_minor) ON reply_records TO sevari_app;

------------------------------------------------------------------------------------------------
-- Wake workers immediately when work is queued (ACK latency, F7). Payload is the cell only.
------------------------------------------------------------------------------------------------
CREATE FUNCTION sevari_meta.job_queue_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('sevari_jobs', 'queued');
  RETURN NULL;
END $$;
CREATE TRIGGER job_queue_notify AFTER INSERT ON job_queue FOR EACH STATEMENT EXECUTE FUNCTION sevari_meta.job_queue_notify();
