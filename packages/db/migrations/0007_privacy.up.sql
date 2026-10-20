-- 0007 privacy (Phase 7, §6.3, §6.4, §17.2, §21.2): per-person keys so erasure is cryptographic,
-- the data-rights request register, the consent ledger, the erasure log and retention runs.

------------------------------------------------------------------------------------------------
-- Subject keys: one data key per person (contact). Everything about that person is sealed with it,
-- so erasing them shreds one key and their data becomes unreadable everywhere it was ever copied:
-- table residue, write-ahead log, replicas and backups (§6.3, F5).
------------------------------------------------------------------------------------------------
CREATE TABLE subject_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  region      region_code NOT NULL,
  -- The contact id. Not a foreign key: the key must outlive the contact row as a shredded tombstone.
  subject_ref uuid NOT NULL,
  kek_id      text NOT NULL,
  wrapped_dek bytea,
  state       text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'shredded')),
  shredded_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK ((state = 'shredded') = (wrapped_dek IS NULL)),
  CHECK ((state = 'shredded') = (shredded_at IS NOT NULL))
);
CREATE UNIQUE INDEX subject_keys_one_active ON subject_keys (tenant_id, subject_ref) WHERE state = 'active';
CREATE TRIGGER subject_keys_touch BEFORE UPDATE ON subject_keys FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
CREATE FUNCTION sevari_meta.subject_keys_no_unshred() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'shredded' THEN
    RAISE EXCEPTION 'subject key % is shredded and cannot be restored', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subject_keys_no_unshred BEFORE UPDATE ON subject_keys FOR EACH ROW EXECUTE FUNCTION sevari_meta.subject_keys_no_unshred();
SELECT sevari_meta.apply_tenant_rls('subject_keys', 'SELECT, INSERT');
GRANT UPDATE (state, wrapped_dek, shredded_at, kek_id) ON subject_keys TO sevari_app;
-- KEK rotation re-wraps keys in place (§67, T-KEY-1).
GRANT UPDATE (kek_id) ON tenant_keys TO sevari_app;

-- Questions and notices about a person carry their id, so their text is sealed with that person's key
-- and erasure can find them. ON DELETE SET NULL: the decision record outlives the person, unreadably.
ALTER TABLE human_questions ADD COLUMN subject_contact_id uuid,
  ADD CONSTRAINT human_questions_subject_fk FOREIGN KEY (tenant_id, subject_contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (subject_contact_id);
ALTER TABLE human_notifications ADD COLUMN subject_contact_id uuid,
  ADD CONSTRAINT human_notifications_subject_fk FOREIGN KEY (tenant_id, subject_contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (subject_contact_id);
-- Erasure zeroes the content digests left on decision records (they are hashes of the person's messages).
GRANT UPDATE (content_digest) ON human_questions TO sevari_app;
GRANT UPDATE (response_digest) ON human_inputs TO sevari_app;
GRANT DELETE ON human_notifications TO sevari_app;
ALTER TABLE human_questions DROP CONSTRAINT human_questions_kind_check;
ALTER TABLE human_questions ADD CONSTRAINT human_questions_kind_check
  CHECK (kind IN ('approve_draft', 'clarify_edit', 'owner_task', 'autonomy_grant', 'knowledge_update', 'dsar_release'));

------------------------------------------------------------------------------------------------
-- Data-rights requests (§21.2): detected on every channel, clocked, released by a human (§8.3).
-- For tenant data the tenant is the controller: the owner decides, Sevari assembles and executes.
------------------------------------------------------------------------------------------------
CREATE TABLE dsar_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  region              region_code NOT NULL,
  contact_id          uuid,
  source_message_id   uuid,
  kind                text NOT NULL CHECK (kind IN ('access', 'erasure', 'rectification', 'restriction', 'objection', 'portability', 'unspecified')),
  identity            text NOT NULL CHECK (identity IN ('channel_verified', 'owner_verified', 'unverified')),
  received_at         timestamptz NOT NULL,
  due_at              timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'awaiting_release'
                      CHECK (status IN ('awaiting_release', 'releasing', 'completed', 'refused', 'withdrawn')),
  question_id         uuid,
  export_enc          bytea,
  download_prefix     text UNIQUE CHECK (download_prefix ~ '^dl_[a-z0-9]{12}$'),
  download_hash       bytea,
  download_expires_at timestamptz,
  downloaded_at       timestamptz,
  completed_at        timestamptz,
  outcome             text,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  version             integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK (due_at > received_at),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (tenant_id, source_message_id) REFERENCES messages (tenant_id, id) ON DELETE SET NULL (source_message_id)
);
COMMENT ON COLUMN dsar_requests.export_enc IS '@pii contact the assembled copy of the person''s data, sealed with their own key';
CREATE INDEX dsar_requests_open ON dsar_requests (tenant_id, status, due_at);
CREATE TRIGGER dsar_requests_touch BEFORE UPDATE ON dsar_requests FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('dsar_requests', 'SELECT, INSERT');
GRANT UPDATE (status, question_id, export_enc, download_prefix, download_hash, download_expires_at, downloaded_at, completed_at, outcome, contact_id) ON dsar_requests TO sevari_app;
-- The one-time download link is found before the tenant is known, by its prefix only (like API keys).
CREATE POLICY dsar_download_lookup ON dsar_requests FOR SELECT TO sevari_app
  USING (download_prefix = nullif(current_setting('app.dsar_download_prefix', true), ''));

------------------------------------------------------------------------------------------------
-- Consent ledger (§17.2, Tier B): append-only events per person, purpose and channel. The current
-- state is the latest event. Proof of consent is exportable per person (DSAR).
------------------------------------------------------------------------------------------------
CREATE TABLE consents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  region          region_code NOT NULL,
  contact_id      uuid NOT NULL,
  purpose         text NOT NULL CHECK (purpose IN ('marketing', 'reminders', 'review_requests', 'updates', 'partner_referral')),
  channel         text NOT NULL CHECK (channel IN ('email', 'sms', 'all')),
  action          text NOT NULL CHECK (action IN ('granted', 'withdrawn')),
  basis           text NOT NULL,
  source          text NOT NULL,
  wording_version text,
  evidence_ref    text,
  recorded_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  version         integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  -- A grant needs the exact wording the person saw; a withdrawal never does (it always counts).
  CHECK (action <> 'granted' OR wording_version IS NOT NULL),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX consents_current ON consents (tenant_id, contact_id, purpose, channel, recorded_at DESC);
SELECT sevari_meta.apply_tenant_rls('consents', 'SELECT, INSERT');

------------------------------------------------------------------------------------------------
-- Erasure log: what was erased, when and why, holding only ids and keyed blind indexes. Kept so an
-- erasure can be re-applied after a backup restore (F35) and proven to the person or a regulator.
------------------------------------------------------------------------------------------------
CREATE TABLE erasure_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  region      region_code NOT NULL,
  subject_ref uuid NOT NULL,
  identifiers bytea[] NOT NULL DEFAULT '{}',
  reason      text NOT NULL CHECK (reason IN ('dsar_erasure', 'retention', 'tenant_exit')),
  request_ref text,
  certificate jsonb NOT NULL,
  erased_at   timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);
COMMENT ON COLUMN erasure_log.identifiers IS '@pii contact keyed blind indexes of the erased person''s email and phone (to re-apply erasure after a restore)';
SELECT sevari_meta.apply_tenant_rls('erasure_log', 'SELECT, INSERT');

-- Retention runs (§6.4): report-only until counsel confirms a retention period; then enforced.
CREATE TABLE retention_runs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  region     region_code NOT NULL,
  ran_at     timestamptz NOT NULL,
  findings   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version    integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);
SELECT sevari_meta.apply_tenant_rls('retention_runs', 'SELECT, INSERT');
