-- 0013 Sevari's own billing (Lifecycle V, §19.4, §47) and accounting sync (§19.5).
-- Plans and prices are versioned data with an approval record, never code. Billing reads only usage
-- counters, never message content. Suspension for non-payment is always a human decision.

------------------------------------------------------------------------------------------------
-- Plans (§47): cell-wide, versioned, effective-dated. A version is usable only once approved by Dan
-- (a platform decision). Written by the owner role from config/plans.yaml; the app only reads.
------------------------------------------------------------------------------------------------
CREATE TABLE plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region              region_code NOT NULL REFERENCES regions(code),
  plan_key            text NOT NULL CHECK (plan_key ~ '^[a-z][a-z0-9_]*$'),
  plan_version        integer NOT NULL CHECK (plan_version > 0),
  name                text NOT NULL,
  price_minor         bigint NOT NULL CHECK (price_minor >= 0),
  currency            text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  vat_treatment       text NOT NULL CHECK (vat_treatment IN ('inclusive', 'exclusive', 'not_registered')),
  allowances          jsonb NOT NULL,
  overage_per_enquiry_minor bigint NOT NULL DEFAULT 0 CHECK (overage_per_enquiry_minor >= 0),
  effective_from      date NOT NULL,
  approval_decision_id uuid REFERENCES platform_decisions(id),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  version             integer NOT NULL DEFAULT 1,
  UNIQUE (region, plan_key, plan_version)
);
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans FORCE ROW LEVEL SECURITY;
CREATE POLICY plans_read ON plans FOR SELECT TO sevari_app USING (region = sevari_meta.app_region());
CREATE POLICY plans_admin ON plans FOR ALL TO sevari_owner USING (true) WITH CHECK (true);
GRANT SELECT ON plans TO sevari_app;

------------------------------------------------------------------------------------------------
-- Subscriptions: Veylith's records about the businesses it bills, held in the house tenant (Veylith is
-- the controller). Terms (pilot end, founding-rate lock) are set by a human decision (§47, §8.3).
------------------------------------------------------------------------------------------------
CREATE TABLE subscriptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  region              region_code NOT NULL,
  business_tenant_id  uuid NOT NULL REFERENCES tenants(id),
  contact_id          uuid NOT NULL,
  plan_key            text NOT NULL,
  pilot_until         date,
  founding_price_minor bigint CHECK (founding_price_minor >= 0),
  founding_lock_until date,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('pilot', 'active', 'past_due', 'suspended', 'cancelled')),
  started_on          date NOT NULL,
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  terms_input_id      uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  version             integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, business_tenant_id),
  CHECK (period_end > period_start),
  CHECK ((founding_price_minor IS NULL) = (founding_lock_until IS NULL)),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, terms_input_id) REFERENCES human_inputs (tenant_id, id)
);
CREATE TRIGGER subscriptions_touch BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('subscriptions', 'SELECT, INSERT');
GRANT UPDATE (status, period_start, period_end) ON subscriptions TO sevari_app;

-- One billing run per subscription and period: usage counts (no content) and the invoice it produced.
CREATE TABLE billing_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  region          region_code NOT NULL,
  subscription_id uuid NOT NULL,
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  usage           jsonb NOT NULL,
  invoice_id      uuid,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  version         integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, subscription_id, period_start),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES subscriptions (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);
COMMENT ON COLUMN billing_runs.usage IS 'counts only (resolved enquiries, seats, channels); never message content (§19.4)';
SELECT sevari_meta.apply_tenant_rls('billing_runs', 'SELECT, INSERT');
GRANT UPDATE (invoice_id) ON billing_runs TO sevari_app;

-- Suspension for non-payment needs Veylith's recorded decision (§8.3); the database checks for it.
CREATE OR REPLACE FUNCTION sevari_meta.tenants_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('active', 'shadow') THEN
    IF NOT EXISTS (SELECT 1 FROM tenant_activations a WHERE a.tenant_id = NEW.id AND a.mode = NEW.status AND a.txid = txid_current()
                     AND (NOT NEW.regulated OR a.platform_decision_id IS NOT NULL)) THEN
      RAISE EXCEPTION 'business % can only go % with a recorded go-live decision (§18, §81)', NEW.id, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'suspended' THEN
    IF NOT EXISTS (SELECT 1 FROM platform_decisions d WHERE d.scope = 'tenant:' || NEW.id || ':suspension' AND d.decision = 'signoff'
                     AND d.approver_role = 'founder' AND d.expires_on >= current_date) THEN
      RAISE EXCEPTION 'business % can only be suspended with Veylith''s recorded decision (§8.3, §19.4)', NEW.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.regulated AND NOT NEW.regulated AND current_user <> 'sevari_owner' THEN
    RAISE EXCEPTION 'a regulated-activity finding can only be cleared by Veylith' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

------------------------------------------------------------------------------------------------
-- Accounting sync (§19.5): each business connects its own accounting software. Tokens are sealed with a
-- key of their own and shredded on disconnect. Every push is idempotent and logged for the owner.
------------------------------------------------------------------------------------------------
CREATE TABLE accounting_connections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  region          region_code NOT NULL,
  provider        text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]*$'),
  token_enc       bytea,
  status          text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected', 'error')),
  connected_at    timestamptz NOT NULL,
  disconnected_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  version         integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK ((status = 'disconnected') = (token_enc IS NULL AND disconnected_at IS NOT NULL))
);
COMMENT ON COLUMN accounting_connections.token_enc IS 'access token, sealed with its own key; shredded on disconnect (§19.5)';
CREATE UNIQUE INDEX accounting_one_connected ON accounting_connections (tenant_id) WHERE status <> 'disconnected';
CREATE TRIGGER accounting_connections_touch BEFORE UPDATE ON accounting_connections FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('accounting_connections', 'SELECT, INSERT');
GRANT UPDATE (token_enc, status, disconnected_at) ON accounting_connections TO sevari_app;

CREATE TABLE accounting_mappings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  region         region_code NOT NULL,
  connection_id  uuid NOT NULL,
  local_account  text NOT NULL,
  external_code  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  version        integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, connection_id, local_account),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES accounting_connections (tenant_id, id)
);
SELECT sevari_meta.apply_tenant_rls('accounting_mappings', 'SELECT, INSERT');

CREATE TABLE accounting_sync_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  region          region_code NOT NULL,
  connection_id   uuid NOT NULL,
  entity          text NOT NULL CHECK (entity IN ('invoice', 'payment', 'credit_note')),
  entity_id       uuid NOT NULL,
  idempotency_key text NOT NULL,
  external_id     text,
  status          text NOT NULL CHECK (status IN ('pushed', 'failed')),
  error           text,
  attempted_at    timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  version         integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES accounting_connections (tenant_id, id)
);
CREATE UNIQUE INDEX accounting_sync_once ON accounting_sync_log (tenant_id, idempotency_key) WHERE status = 'pushed';
SELECT sevari_meta.apply_tenant_rls('accounting_sync_log', 'SELECT, INSERT');
