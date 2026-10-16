ALTER TABLE reply_records DROP COLUMN IF EXISTS prompt_id;
ALTER TABLE enquiries DROP CONSTRAINT IF EXISTS enquiries_model_lineage, DROP COLUMN IF EXISTS intent_model_id, DROP COLUMN IF EXISTS intent_prompt_id;
DROP TABLE IF EXISTS model_registry;
