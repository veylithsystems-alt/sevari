ALTER TABLE human_questions DROP CONSTRAINT IF EXISTS human_questions_kind_check;
ALTER TABLE human_questions ADD CONSTRAINT human_questions_kind_check
  CHECK (kind IN ('approve_draft', 'clarify_edit', 'owner_task', 'autonomy_grant', 'knowledge_update', 'dsar_release', 'lifecycle_step'));
DROP TABLE IF EXISTS data_imports;
ALTER TABLE channel_endpoints DROP COLUMN IF EXISTS verified_at;
ALTER TABLE channel_endpoints DROP COLUMN IF EXISTS check_code_hash;
DROP TABLE IF EXISTS tenant_packs;
DROP TRIGGER IF EXISTS tenants_status_guard ON tenants;
DROP FUNCTION IF EXISTS sevari_meta.tenants_status_guard();
DROP TABLE IF EXISTS tenant_activations;
ALTER TABLE tenants DROP COLUMN IF EXISTS activated_at;
ALTER TABLE tenants DROP COLUMN IF EXISTS regulated_reasons;
ALTER TABLE tenants DROP COLUMN IF EXISTS regulated;
