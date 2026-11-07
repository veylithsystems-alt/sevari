ALTER TABLE human_questions DROP CONSTRAINT IF EXISTS human_questions_kind_check;
ALTER TABLE human_questions ADD CONSTRAINT human_questions_kind_check
  CHECK (kind IN ('approve_draft', 'clarify_edit', 'owner_task', 'autonomy_grant', 'knowledge_update', 'dsar_release', 'lifecycle_step', 'go_live', 'pack_confirm'));
DROP TABLE IF EXISTS complaint_cases;
ALTER TABLE knowledge_records DROP CONSTRAINT IF EXISTS knowledge_records_kind_check;
ALTER TABLE knowledge_records ADD CONSTRAINT knowledge_records_kind_check
  CHECK (kind IN ('service', 'price', 'hours', 'area', 'policy', 'faq', 'business'));
REVOKE UPDATE (vulnerable_flag) ON contacts FROM sevari_app;
