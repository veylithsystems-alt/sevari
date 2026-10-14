/**
 * Model registry (§9). Each row is one model build in one cell, with scores measured on the target box
 * (eval/models/bench.ts), never typed in by hand. Selection is deterministic:
 *   the best-scoring ACTIVE model in the cell, for the task and language, within the latency budget.
 * No model qualifies → null, and the caller stays on the deterministic path (§36.2). A model goes
 * active only through a human (promoted_by, enforced by a CHECK in the database).
 */
import { z } from 'zod';
import type { TenantTx } from '@sevari/db';
import type { LlmTask } from './provider.ts';

export const ModelEntrySchema = z.object({
  modelId: z.string().min(3),
  region: z.string().min(2),
  provider: z.enum(['ollama', 'vllm', 'vsap', 'fake']),
  family: z.string().min(1),
  paramsB: z.number().positive(),
  quantisation: z.string().min(1),
  host: z.string().min(1),
  ctxTokens: z.number().int().positive(),
  licence: z.string().min(1),
  tokensPerS: z.number().positive().nullable(),
  /** p95 latency per task, measured. */
  p95LatencyMs: z.record(z.string(), z.number().nonnegative()),
  /** score 0..1 per task, per language (§24 replies only in languages the registry has evaluated). */
  evalScores: z.record(z.string(), z.record(z.string(), z.number().min(0).max(1))),
  costPer1kMinor: z.number().nonnegative(),
  status: z.enum(['candidate', 'active', 'retired']),
}).strict();
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

export interface SelectionCriteria {
  readonly region: string;
  readonly task: LlmTask;
  readonly language?: string;
  readonly latencyBudgetMs: number;
  /** A model scoring below this for the task is never used, however fast. */
  readonly minScore?: number;
}

export interface Selection {
  readonly model: ModelEntry | null;
  /** Why each other model was passed over: lineage for the decision (§32). */
  readonly rejected: readonly { readonly modelId: string; readonly reason: string }[];
}

export function selectModel(entries: readonly ModelEntry[], c: SelectionCriteria): Selection {
  const lang = c.language ?? 'en';
  const minScore = c.minScore ?? 0.8;
  const rejected: { modelId: string; reason: string }[] = [];
  const eligible: { e: ModelEntry; score: number; p95: number }[] = [];
  for (const e of entries) {
    const score = e.evalScores[c.task]?.[lang];
    const p95 = e.p95LatencyMs[c.task];
    const reason = e.region !== c.region ? 'other_region'
      : e.status !== 'active' ? `status_${e.status}`
        : score === undefined ? 'not_evaluated_for_task_language'
          : score < minScore ? 'score_below_floor'
            : p95 === undefined ? 'latency_not_measured'
              : p95 > c.latencyBudgetMs ? 'over_latency_budget'
                : null;
    if (reason || score === undefined || p95 === undefined) rejected.push({ modelId: e.modelId, reason: reason ?? 'unknown' });
    else eligible.push({ e, score, p95 });
  }
  // Best score; ties broken by lower latency, then lower cost, then id (stable, deterministic).
  eligible.sort((a, b) => b.score - a.score || a.p95 - b.p95 || a.e.costPer1kMinor - b.e.costPer1kMinor || a.e.modelId.localeCompare(b.e.modelId));
  const [best, ...rest] = eligible;
  for (const r of rest) rejected.push({ modelId: r.e.modelId, reason: 'outscored' });
  return { model: best?.e ?? null, rejected };
}

/** The cell's registry as the app sees it (RLS: own region only). */
export async function loadModelRegistry(tx: TenantTx): Promise<ModelEntry[]> {
  const rows = await tx.selectFrom('model_registry').selectAll().orderBy('model_id').execute();
  return rows.map((r) => ModelEntrySchema.parse({
    modelId: r.model_id, region: r.region, provider: r.provider, family: r.family, paramsB: Number(r.params_b),
    quantisation: r.quantisation, host: r.host, ctxTokens: r.ctx_tokens, licence: r.licence,
    tokensPerS: r.tokens_per_s === null ? null : Number(r.tokens_per_s), p95LatencyMs: r.p95_latency_ms, evalScores: r.eval_scores,
    costPer1kMinor: Number(r.cost_per_1k_minor), status: r.status,
  }));
}
