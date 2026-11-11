-- 0015 offloading, offboarding and the customer portal (§21, §22, Phase 15).

------------------------------------------------------------------------------------------------
-- Partners a business may hand a case to (§21.3): each with its relationship and lawful basis. A
-- handover goes only to an approved processor (config/processors.yaml) or a partner recorded here (F19).
------------------------------------------------------------------------------------------------
CREATE TABLE partners (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  region        region_code NOT NULL,
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('subcontractor', 'specialist', 'partner_firm', 'insurer', 'regulator', 'debt_recovery')),
  relationship  text NOT NULL CHECK (relationship IN ('processor', 'controller')),
  lawful_basis  text NOT NULL CHECK (length(btrim(lawful_basis)) > 0),
  dpa_ref       text,
  enabled       boolean NOT NULL DEFAULT true,
  recorded_by   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  version       integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  -- A processor partner needs a data processing agreement on record.
  CHECK (relationship <> 'processor' OR dpa_ref IS NOT NULL)
);
COMMENT ON COLUMN partners.name IS '@pii contact a sole-trader partner''s name can be personal data';
CREATE TRIGGER partners_touch BEFORE UPDATE ON partners FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('partners', 'SELECT, INSERT');
GRANT UPDATE (enabled) ON partners TO sevari_app;

CREATE TABLE offloads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  region         region_code NOT NULL,
  case_ref       text NOT NULL,
  contact_id     uuid,
  partner_id     uuid,
  processor_id   text,
  purpose        text NOT NULL CHECK (purpose IN ('subcontract', 'specialist', 'partner_referral', 'insurance', 'regulator', 'debt_recovery')),
  lawful_basis   text NOT NULL,
  fields         text[] NOT NULL CHECK (cardinality(fields) > 0),
  bundle_enc     bytea,
  status         text NOT NULL DEFAULT 'awaiting_approval' CHECK (status IN ('awaiting_approval', 'approved', 'refused', 'cancelled')),
  -- T-OFF-1: someone always owns it.
  owner_user_id  uuid NOT NULL,
  input_id       uuid,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  version        integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK ((partner_id IS NULL) <> (processor_id IS NULL)),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES partners (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users (tenant_id, id)
);
COMMENT ON COLUMN offloads.bundle_enc IS '@pii contact the minimum data handed over, sealed with the person''s key';
CREATE TRIGGER offloads_touch BEFORE UPDATE ON offloads FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('offloads', 'SELECT, INSERT');
GRANT UPDATE (status, input_id, bundle_enc, owner_user_id) ON offloads TO sevari_app;

------------------------------------------------------------------------------------------------
-- Leaving Sevari (§21.1): notice, export, grace, then erasure only on Veylith's recorded decision.
------------------------------------------------------------------------------------------------
CREATE TABLE tenant_offboardings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  region              region_code NOT NULL,
  reason              text NOT NULL CHECK (reason IN ('owner', 'non_payment', 'veylith')),
  requested_at        timestamptz NOT NULL,
  notice_until        timestamptz NOT NULL,
  grace_until         timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'notice' CHECK (status IN ('notice', 'grace', 'erased', 'cancelled')),
  exported_at         timestamptz,
  erasure_decision_id uuid REFERENCES platform_decisions(id),
  certificate         jsonb,
  erased_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  version             integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK (grace_until >= notice_until AND notice_until > requested_at),
  CHECK (status <> 'erased' OR (erasure_decision_id IS NOT NULL AND certificate IS NOT NULL AND erased_at IS NOT NULL))
);
CREATE UNIQUE INDEX tenant_offboardings_one_open ON tenant_offboardings (tenant_id) WHERE status IN ('notice', 'grace');
CREATE TRIGGER tenant_offboardings_touch BEFORE UPDATE ON tenant_offboardings FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('tenant_offboardings', 'SELECT, INSERT');
GRANT UPDATE (status, exported_at, erasure_decision_id, certificate, erased_at) ON tenant_offboardings TO sevari_app;

------------------------------------------------------------------------------------------------
-- The customer portal (§22): a magic link per person, found by its prefix before the business is known.
------------------------------------------------------------------------------------------------
CREATE TABLE portal_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  region       region_code NOT NULL,
  contact_id   uuid NOT NULL,
  prefix       text NOT NULL UNIQUE CHECK (prefix ~ '^pl_[a-z0-9]{12}$'),
  token_hash   bytea NOT NULL,
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);
COMMENT ON COLUMN portal_tokens.token_hash IS '@pii contact hash of a link that opens one person''s page';
CREATE TRIGGER portal_tokens_touch BEFORE UPDATE ON portal_tokens FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('portal_tokens', 'SELECT, INSERT');
GRANT UPDATE (last_used_at) ON portal_tokens TO sevari_app;
GRANT DELETE ON portal_tokens TO sevari_app;
CREATE POLICY portal_lookup ON portal_tokens FOR SELECT TO sevari_app
  USING (prefix = nullif(current_setting('app.portal_prefix', true), ''));

ALTER TABLE human_questions DROP CONSTRAINT human_questions_kind_check;
ALTER TABLE human_questions ADD CONSTRAINT human_questions_kind_check
  CHECK (kind IN ('approve_draft', 'clarify_edit', 'owner_task', 'autonomy_grant', 'knowledge_update', 'dsar_release', 'lifecycle_step', 'go_live', 'pack_confirm', 'complaint', 'offload'));
-- Reassigning work when a team member leaves (T-OFF-1).
GRANT UPDATE (status) ON users TO sevari_app;
GRANT UPDATE (status) ON channel_endpoints TO sevari_app;

-- The house tenant (Veylith's own account) for a region, visible by itself only when a job asks for it
-- (final billing on offboarding, §21.1). It reveals the house tenant's id and region, nothing else of any tenant.
CREATE POLICY house_lookup ON tenants FOR SELECT TO sevari_app
  USING (is_house AND region = nullif(current_setting('app.house_region', true), ''));
