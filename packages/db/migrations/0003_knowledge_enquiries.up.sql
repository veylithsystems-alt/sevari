-- 0003 knowledge and enquiries. Contract §6.2 (knowledge_records with source, effective period and
-- version; enquiries, intents, slots), I5 (typed owner knowledge), §10.2 (facts_used / facts_missing).

------------------------------------------------------------------------------------------------
-- Knowledge records: append-only versions. A new version is a new row; confirming it closes the
-- previous version's effective period. Only owner-confirmed versions are facts (I5).
------------------------------------------------------------------------------------------------
CREATE TABLE knowledge_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  region         region_code NOT NULL,
  record_key     text NOT NULL CHECK (record_key ~ '^[a-z][a-z0-9_:.-]{1,127}$'),
  kind           text NOT NULL CHECK (kind IN ('service', 'price', 'hours', 'area', 'policy', 'faq', 'business')),
  record_version integer NOT NULL CHECK (record_version > 0),
  body_enc       bytea NOT NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'retired', 'rejected')),
  source         text NOT NULL CHECK (source IN ('onboarding_interview', 'owner_edit', 'import', 'register_prefill', 'system_default')),
  proposed_by    text NOT NULL,
  confirmed_by   text,
  confirmed_at   timestamptz,
  effective_from timestamptz,
  effective_to   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  version        integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, record_key, record_version),
  CHECK ((status IN ('confirmed', 'retired')) = (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL AND effective_from IS NOT NULL)),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
COMMENT ON COLUMN knowledge_records.body_enc IS 'encrypted owner knowledge (business facts; may include a sole trader''s contact details)';
-- At most one confirmed, open-ended version per key.
CREATE UNIQUE INDEX knowledge_one_current ON knowledge_records (tenant_id, record_key) WHERE status = 'confirmed' AND effective_to IS NULL;
CREATE INDEX knowledge_effective ON knowledge_records (tenant_id, kind, effective_from);
CREATE TRIGGER knowledge_records_touch BEFORE UPDATE ON knowledge_records FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
-- Bodies are immutable once written: a change is a new version.
CREATE FUNCTION sevari_meta.knowledge_body_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body_enc IS DISTINCT FROM OLD.body_enc OR NEW.record_key IS DISTINCT FROM OLD.record_key
     OR NEW.record_version IS DISTINCT FROM OLD.record_version OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'knowledge record bodies are immutable; create a new version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_body_immutable BEFORE UPDATE ON knowledge_records FOR EACH ROW EXECUTE FUNCTION sevari_meta.knowledge_body_immutable();
SELECT sevari_meta.apply_tenant_rls('knowledge_records', 'SELECT, INSERT');
GRANT UPDATE (status, confirmed_by, confirmed_at, effective_from, effective_to) ON knowledge_records TO sevari_app;

------------------------------------------------------------------------------------------------
-- Enquiries: the deterministic core's result for one inbound message (one row per message).
-- Codes are plain for metrics; the full analysis (slots include contact details) is encrypted.
------------------------------------------------------------------------------------------------
CREATE TABLE enquiries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  region            region_code NOT NULL,
  message_id        uuid NOT NULL,
  conversation_id   uuid NOT NULL,
  pack_id           text NOT NULL,
  pack_version      text NOT NULL,
  core_version      text NOT NULL,
  intent            text NOT NULL,
  intent_confidence numeric(4, 3) NOT NULL CHECK (intent_confidence BETWEEN 0 AND 1),
  intent_source     text NOT NULL CHECK (intent_source IN ('rules', 'model')),
  abstained         boolean NOT NULL,
  route             text NOT NULL CHECK (route IN ('safety_first', 'human_only', 'opt_out', 'clarify', 'unknown', 'answer')),
  services          text[] NOT NULL DEFAULT '{}',
  flags             text[] NOT NULL DEFAULT '{}',
  urgency           text NOT NULL,
  eligibility       text NOT NULL CHECK (eligibility IN ('yes', 'no', 'unknown')),
  facts_used        text[] NOT NULL DEFAULT '{}',
  facts_missing     text[] NOT NULL DEFAULT '{}',
  analysis_enc      bytea NOT NULL,
  analysed_at       timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  version           integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  -- Idempotent step: one analysis per message (§5.2).
  UNIQUE (tenant_id, message_id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE
);
COMMENT ON COLUMN enquiries.analysis_enc IS '@pii contact encrypted full analysis (slots include name, email, phone, postcode)';
COMMENT ON COLUMN enquiries.flags IS '@pii special sensitive-content flags (e.g. vulnerable_customer); signals for a human, never inferences about a person';
CREATE INDEX enquiries_conversation ON enquiries (tenant_id, conversation_id, analysed_at);
CREATE TRIGGER enquiries_touch BEFORE UPDATE ON enquiries FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('enquiries', 'SELECT, INSERT, DELETE');
