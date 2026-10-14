-- 0002 intake: channel endpoints, API keys, inbound message fields, and the tenant-scoped job queue.
-- Contract §5.2 (receive → authenticate → persist raw encrypted → ACK), §9 channel adapters, §36.1 API keys,
-- Part K §75 (an inbound item is an enquiry or a task), ADR-0002 (workflow port), DEV-007 (own queue).

-- The worker role reads the job queue across tenants (ids only, no personal data) and then does every
-- piece of real work inside withTenant(). It has no access to any other table outside a tenant scope.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sevari_worker') THEN
    RAISE EXCEPTION 'role sevari_worker missing: run the cluster bootstrap first';
  END IF;
END $$;

------------------------------------------------------------------------------------------------
-- Channel endpoints: how an inbound request finds its tenant. The public id is an unguessable
-- capability in the URL; the secret (HMAC key) is sealed with the tenant's data key.
------------------------------------------------------------------------------------------------
CREATE TABLE channel_endpoints (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  region          region_code NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('webform', 'email', 'sms', 'api', 'telephony')),
  public_id       text NOT NULL UNIQUE CHECK (public_id ~ '^[A-Za-z0-9_-]{22,64}$'),
  secret_enc      bytea,
  -- §8.4 / §17.1: the lawful basis for processing what arrives here is recorded by a human at set-up.
  lawful_basis    text NOT NULL,
  purpose         text NOT NULL,
  allowed_origins text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  version         integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);
COMMENT ON COLUMN channel_endpoints.secret_enc IS 'sealed HMAC key; tenant-key encrypted';
CREATE TRIGGER channel_endpoints_touch BEFORE UPDATE ON channel_endpoints FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('channel_endpoints', 'SELECT, INSERT, UPDATE');
-- Lookup before the tenant is known: only the row whose public id the caller presents is visible.
CREATE POLICY endpoint_lookup ON channel_endpoints FOR SELECT TO sevari_app
  USING (public_id = nullif(current_setting('app.endpoint_public_id', true), '') AND status = 'active');

------------------------------------------------------------------------------------------------
-- API keys (§36.1 per-tenant keys). Only a hash of the high-entropy secret is stored.
------------------------------------------------------------------------------------------------
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  region       region_code NOT NULL,
  prefix       text NOT NULL UNIQUE CHECK (prefix ~ '^sk_[a-z0-9]{12}$'),
  key_hash     bytea NOT NULL,
  scopes       text[] NOT NULL CHECK (cardinality(scopes) > 0),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);
CREATE TRIGGER api_keys_touch BEFORE UPDATE ON api_keys FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('api_keys', 'SELECT, INSERT, UPDATE');
CREATE POLICY api_key_lookup ON api_keys FOR SELECT TO sevari_app
  USING (prefix = nullif(current_setting('app.api_key_prefix', true), '') AND status = 'active');

------------------------------------------------------------------------------------------------
-- Inbound message fields. An inbound item is an enquiry (from a customer) or a task (from the
-- tenant, Part K). Contacts are deduplicated by blind index.
------------------------------------------------------------------------------------------------
ALTER TABLE messages ADD COLUMN kind text NOT NULL DEFAULT 'enquiry' CHECK (kind IN ('enquiry', 'task'));
ALTER TABLE messages ADD COLUMN subject_enc bytea;
ALTER TABLE messages ADD COLUMN raw_enc bytea;
ALTER TABLE messages ADD COLUMN endpoint_id uuid;
ALTER TABLE messages ADD CONSTRAINT messages_endpoint_fk FOREIGN KEY (tenant_id, endpoint_id) REFERENCES channel_endpoints (tenant_id, id);
COMMENT ON COLUMN messages.subject_enc IS '@pii contact encrypted subject';
COMMENT ON COLUMN messages.raw_enc IS '@pii contact encrypted raw inbound payload (§5.2 persist raw)';

CREATE UNIQUE INDEX contacts_email_unique ON contacts (tenant_id, email_bidx) WHERE email_bidx IS NOT NULL;
CREATE UNIQUE INDEX contacts_phone_unique ON contacts (tenant_id, phone_bidx) WHERE phone_bidx IS NOT NULL;
DROP INDEX IF EXISTS contacts_email_bidx;
DROP INDEX IF EXISTS contacts_phone_bidx;

------------------------------------------------------------------------------------------------
-- Job queue (ADR-0002 workflow port, v1 implementation, DEV-007). Payloads hold ids only.
-- Idempotent enqueue on (tenant_id, kind, dedupe_key). Claims use FOR UPDATE SKIP LOCKED.
------------------------------------------------------------------------------------------------
CREATE TABLE job_queue (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  region       region_code NOT NULL,
  kind         text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{2,63}$'),
  dedupe_key   text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  state        text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed', 'dead')),
  run_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 25),
  locked_by    text,
  locked_until timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, kind, dedupe_key),
  UNIQUE (tenant_id, id)
);
COMMENT ON COLUMN job_queue.payload IS 'ids and codes only; never personal data';
CREATE INDEX job_queue_ready ON job_queue (run_at) WHERE state = 'queued';
CREATE TRIGGER job_queue_touch BEFORE UPDATE ON job_queue FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('job_queue', 'SELECT, INSERT, UPDATE');
-- The worker sees and updates queue rows of every tenant in this cell, and nothing else.
CREATE POLICY worker_claim ON job_queue FOR ALL TO sevari_worker
  USING (region = sevari_meta.app_region()) WITH CHECK (region = sevari_meta.app_region());
GRANT USAGE ON SCHEMA public, sevari_meta TO sevari_worker;
GRANT SELECT, UPDATE ON job_queue TO sevari_worker;
GRANT EXECUTE ON FUNCTION sevari_meta.app_region() TO sevari_worker;
