-- 0014 complaints and disputes (Part B §20, Phase 14): a first-class workflow with a case file, a clock,
-- an owner at every moment, remedies limited to the business's own resolution policy, and closure with a
-- root cause. Always-human complaints get no reply beyond the holding acknowledgement.

ALTER TABLE knowledge_records DROP CONSTRAINT knowledge_records_kind_check;
ALTER TABLE knowledge_records ADD CONSTRAINT knowledge_records_kind_check
  CHECK (kind IN ('service', 'price', 'hours', 'area', 'policy', 'faq', 'business', 'resolution_policy'));

CREATE TABLE complaint_cases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  region           region_code NOT NULL,
  contact_id       uuid,
  enquiry_id       uuid,
  conversation_id  uuid,
  category         text NOT NULL CHECK (category IN ('standard', 'always_human')),
  reasons          text[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'remedy_proposed', 'resolved', 'closed')),
  -- T-OFF-1: a case always has a named owner while it is open.
  assigned_user_id uuid,
  opened_at        timestamptz NOT NULL,
  respond_by       timestamptz NOT NULL,
  breached_at      timestamptz,
  resolved_at      timestamptz,
  remedy           jsonb,
  root_cause       text CHECK (root_cause IN ('workmanship', 'communication', 'price', 'timing', 'damage', 'no_fault', 'other')),
  satisfaction_opt_in boolean,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  version          integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK (status IN ('resolved', 'closed') OR assigned_user_id IS NOT NULL),
  CHECK (status <> 'closed' OR root_cause IS NOT NULL),
  CHECK (respond_by > opened_at),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (tenant_id, enquiry_id) REFERENCES enquiries (tenant_id, id) ON DELETE SET NULL (enquiry_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE SET NULL (conversation_id),
  FOREIGN KEY (tenant_id, assigned_user_id) REFERENCES users (tenant_id, id)
);
COMMENT ON COLUMN complaint_cases.remedy IS 'type and amount only, from the resolution policy; no message content';
CREATE INDEX complaint_cases_open ON complaint_cases (tenant_id, status, respond_by);
CREATE UNIQUE INDEX complaint_cases_one_open_per_conversation ON complaint_cases (tenant_id, conversation_id) WHERE status IN ('open', 'remedy_proposed');
CREATE TRIGGER complaint_cases_touch BEFORE UPDATE ON complaint_cases FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('complaint_cases', 'SELECT, INSERT');
GRANT UPDATE (status, assigned_user_id, breached_at, resolved_at, remedy, root_cause, satisfaction_opt_in) ON complaint_cases TO sevari_app;

ALTER TABLE human_questions DROP CONSTRAINT human_questions_kind_check;
ALTER TABLE human_questions ADD CONSTRAINT human_questions_kind_check
  CHECK (kind IN ('approve_draft', 'clarify_edit', 'owner_task', 'autonomy_grant', 'knowledge_update', 'dsar_release', 'lifecycle_step', 'go_live', 'pack_confirm', 'complaint'));
GRANT UPDATE (vulnerable_flag) ON contacts TO sevari_app;
