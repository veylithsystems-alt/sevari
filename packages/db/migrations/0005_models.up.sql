-- 0005 models: the model registry (§9, §6 model_registry) and model lineage on enquiries (§32).
-- The registry is cell configuration: one row per model build per region, no personal data.
-- The app reads it; only a human, through the owner role, registers or promotes a model.

CREATE TABLE model_registry (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region           region_code NOT NULL REFERENCES regions(code),
  -- e.g. 'ollama:qwen2.5:7b-instruct-q4_K_M'. Unique per region.
  model_id         text NOT NULL,
  provider         text NOT NULL CHECK (provider IN ('ollama', 'vllm', 'vsap', 'fake')),
  family           text NOT NULL,
  params_b         numeric(6, 2) NOT NULL CHECK (params_b > 0),
  quantisation     text NOT NULL,
  host             text NOT NULL,
  ctx_tokens       integer NOT NULL CHECK (ctx_tokens > 0),
  licence          text NOT NULL,
  -- Measured on the target box by eval/models/bench.ts, never typed in by hand.
  tokens_per_s     numeric(8, 2),
  p95_latency_ms   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- { "<task>": { "<language>": score 0..1 } } from the bench run named in bench_ref.
  eval_scores      jsonb NOT NULL DEFAULT '{}'::jsonb,
  bench_ref        text,
  cost_per_1k_minor numeric(10, 4) NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'active', 'retired')),
  -- Human gate (§8.3, §31): a model goes live only with a named approver and a bench run.
  promoted_by      text,
  promoted_at      timestamptz,
  retired_reason   text,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  version          integer NOT NULL DEFAULT 1,
  UNIQUE (region, model_id),
  CHECK (status <> 'active' OR (promoted_by IS NOT NULL AND promoted_at IS NOT NULL AND bench_ref IS NOT NULL AND tokens_per_s IS NOT NULL)),
  CHECK (status <> 'retired' OR retired_reason IS NOT NULL)
);
CREATE TRIGGER model_registry_touch BEFORE UPDATE ON model_registry FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
ALTER TABLE model_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_registry FORCE ROW LEVEL SECURITY;
-- The app sees its own cell's models only.
CREATE POLICY model_registry_read ON model_registry FOR SELECT TO sevari_app USING (region = sevari_meta.app_region());
CREATE POLICY model_registry_admin ON model_registry FOR ALL TO sevari_owner USING (true) WITH CHECK (true);
GRANT SELECT ON model_registry TO sevari_app;

-- Model lineage on the analysis (§32 T-REPLAY): which model and prompt labelled this enquiry, if any.
ALTER TABLE enquiries ADD COLUMN intent_model_id text, ADD COLUMN intent_prompt_id text,
  ADD CONSTRAINT enquiries_model_lineage CHECK (intent_source <> 'model' OR (intent_model_id IS NOT NULL AND intent_prompt_id IS NOT NULL));
-- Reply records already carry generator/model_id/tokens; add the prompt for replay.
ALTER TABLE reply_records ADD COLUMN prompt_id text;
