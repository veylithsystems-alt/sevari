/**
 * Model registry administration, as the owner role (provisioning, never the app). The app only reads
 * the registry. Promotion is a human act: it names the approver, and the database refuses an active
 * model without one, without a bench run and without a measured speed (0005 CHECK constraints).
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.ts';

export interface RegistryRow {
  readonly region: string;
  readonly modelId: string;
  readonly provider: 'ollama' | 'vllm' | 'vsap' | 'fake';
  readonly family: string;
  readonly paramsB: number;
  readonly quantisation: string;
  readonly host: string;
  readonly ctxTokens: number;
  readonly licence: string;
  readonly tokensPerS: number | null;
  readonly p95LatencyMs: Readonly<Record<string, number>>;
  readonly evalScores: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly benchRef: string;
  readonly costPer1kMinor: number;
}

async function asOwner<T>(ownerUrl: string, fn: (db: Kysely<Database>) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  pool.on('error', () => undefined);
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

/** Adds or refreshes a model as a candidate with its latest measured scores. Re-benchmarking demotes it to candidate. */
export function registerModel(ownerUrl: string, r: RegistryRow): Promise<void> {
  const values = {
    region: r.region, model_id: r.modelId, provider: r.provider, family: r.family, params_b: r.paramsB, quantisation: r.quantisation,
    host: r.host, ctx_tokens: r.ctxTokens, licence: r.licence, tokens_per_s: r.tokensPerS, p95_latency_ms: JSON.stringify(r.p95LatencyMs),
    eval_scores: JSON.stringify(r.evalScores), bench_ref: r.benchRef, cost_per_1k_minor: r.costPer1kMinor,
  };
  return asOwner(ownerUrl, async (db) => {
    const { region: _r, model_id: _m, ...update } = values;
    await db.insertInto('model_registry').values(values)
      .onConflict((oc) => oc.columns(['region', 'model_id']).doUpdateSet({ ...update, status: 'candidate', promoted_by: null, promoted_at: null })).execute();
  });
}

export function promoteModel(ownerUrl: string, p: { region: string; modelId: string; approvedBy: string; at: Date }): Promise<boolean> {
  return asOwner(ownerUrl, async (db) => {
    const r = await db.updateTable('model_registry').set({ status: 'active', promoted_by: p.approvedBy, promoted_at: p.at, retired_reason: null })
      .where('region', '=', p.region).where('model_id', '=', p.modelId).where('status', '=', 'candidate').executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  });
}

export function retireModel(ownerUrl: string, p: { region: string; modelId: string; reason: string }): Promise<boolean> {
  return asOwner(ownerUrl, async (db) => {
    const r = await db.updateTable('model_registry').set({ status: 'retired', retired_reason: p.reason })
      .where('region', '=', p.region).where('model_id', '=', p.modelId).where('status', '!=', 'retired').executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  });
}

export function listModels(ownerUrl: string, region: string) {
  return asOwner(ownerUrl, (db) => db.selectFrom('model_registry').select(['model_id', 'status', 'tokens_per_s', 'eval_scores', 'p95_latency_ms', 'promoted_by', 'promoted_at', 'bench_ref'])
    .where('region', '=', region).orderBy('model_id').execute());
}
