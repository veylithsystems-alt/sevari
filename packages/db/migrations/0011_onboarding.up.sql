-- 0011 onboarding and go-live (§18, §81, §83, Phase 11).
-- Going live is a typed human decision recorded as an activation; the database refuses any change of a
-- business's status to live or shadow that isn't backed by one, made in the same transaction.

ALTER TABLE tenants ADD COLUMN regulated boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN regulated_reasons text[] NOT NULL DEFAULT '{}';
ALTER TABLE tenants ADD COLUMN activated_at timestamptz;

-- Every go-live (and every move into or out of shadow mode): the checklist as it stood, who decided,
-- and for a regulated business, Veylith's platform approval (§81.5).
CREATE TABLE tenant_activations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  region               region_code NOT NULL,
  mode                 text NOT NULL CHECK (mode IN ('active', 'shadow')),
  checklist            jsonb NOT NULL,
  checklist_ok         boolean NOT NULL CHECK (checklist_ok),
  input_id             uuid NOT NULL,
  decided_by           uuid NOT NULL,
  regulated            boolean NOT NULL,
  platform_decision_id uuid REFERENCES platform_decisions(id),
  txid                 bigint NOT NULL DEFAULT txid_current(),
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  version              integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK (NOT regulated OR platform_decision_id IS NOT NULL),
  FOREIGN KEY (tenant_id, input_id) REFERENCES human_inputs (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users (tenant_id, id)
);
SELECT sevari_meta.apply_tenant_rls('tenant_activations', 'SELECT, INSERT');

CREATE FUNCTION sevari_meta.tenants_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('active', 'shadow') THEN
    IF NOT EXISTS (SELECT 1 FROM tenant_activations a WHERE a.tenant_id = NEW.id AND a.mode = NEW.status AND a.txid = txid_current()
                     AND (NOT NEW.regulated OR a.platform_decision_id IS NOT NULL)) THEN
      RAISE EXCEPTION 'business % can only go % with a recorded go-live decision (§18, §81)', NEW.id, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- A regulated finding can only be cleared by a human through the owner role (§83.4), never by the app.
  IF OLD.regulated AND NOT NEW.regulated AND current_user <> 'sevari_owner' THEN
    RAISE EXCEPTION 'a regulated-activity finding can only be cleared by Veylith' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenants_status_guard BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION sevari_meta.tenants_status_guard();

-- The business's own pack, drafted from its onboarding answers (§83.2): services and everyday names,
-- clarifying questions. No personal data. Live only once the owner confirms it and its tests pass.
CREATE TABLE tenant_packs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  region       region_code NOT NULL,
  pack_version integer NOT NULL CHECK (pack_version > 0),
  body         jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'superseded')),
  test_report  jsonb,
  test_passed  boolean NOT NULL DEFAULT false,
  confirmed_by text,
  confirmed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, pack_version),
  CHECK (status <> 'confirmed' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL AND test_passed))
);
COMMENT ON COLUMN tenant_packs.body IS 'service names, everyday words and questions; no personal data';
CREATE UNIQUE INDEX tenant_packs_one_confirmed ON tenant_packs (tenant_id) WHERE status = 'confirmed';
CREATE TRIGGER tenant_packs_touch BEFORE UPDATE ON tenant_packs FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('tenant_packs', 'SELECT, INSERT');
GRANT UPDATE (status, test_report, test_passed, confirmed_by, confirmed_at) ON tenant_packs TO sevari_app;

-- Channel check (§81.2): a channel counts as working once a test message with its one-time code arrives.
ALTER TABLE channel_endpoints ADD COLUMN check_code_hash bytea;
ALTER TABLE channel_endpoints ADD COLUMN verified_at timestamptz;

-- Imports (§18 step 4): who brought the data in, from where, and on what lawful basis. No basis, no import.
CREATE TABLE data_imports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  region         region_code NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('contacts')),
  lawful_basis   text NOT NULL CHECK (length(btrim(lawful_basis)) > 0),
  acquired_from  text NOT NULL CHECK (length(btrim(acquired_from)) > 0),
  imported_by    text NOT NULL,
  rows_in        integer NOT NULL CHECK (rows_in >= 0),
  rows_imported  integer NOT NULL CHECK (rows_imported >= 0),
  rows_rejected  integer NOT NULL CHECK (rows_rejected >= 0),
  lead_source_key text NOT NULL,
  imported_at    timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  version        integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);
SELECT sevari_meta.apply_tenant_rls('data_imports', 'SELECT, INSERT');

ALTER TABLE human_questions DROP CONSTRAINT human_questions_kind_check;
ALTER TABLE human_questions ADD CONSTRAINT human_questions_kind_check
  CHECK (kind IN ('approve_draft', 'clarify_edit', 'owner_task', 'autonomy_grant', 'knowledge_update', 'dsar_release', 'lifecycle_step', 'go_live', 'pack_confirm'));
