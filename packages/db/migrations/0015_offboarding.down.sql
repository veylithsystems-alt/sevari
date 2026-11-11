DROP POLICY IF EXISTS house_lookup ON tenants;
ALTER TABLE human_questions DROP CONSTRAINT IF EXISTS human_questions_kind_check;
ALTER TABLE human_questions ADD CONSTRAINT human_questions_kind_check
  CHECK (kind IN ('approve_draft', 'clarify_edit', 'owner_task', 'autonomy_grant', 'knowledge_update', 'dsar_release', 'lifecycle_step', 'go_live', 'pack_confirm', 'complaint'));
DROP TABLE IF EXISTS portal_tokens;
DROP TABLE IF EXISTS tenant_offboardings;
DROP TABLE IF EXISTS offloads;
DROP TABLE IF EXISTS partners;
