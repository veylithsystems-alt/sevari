/**
 * Model wording, opt-in per intent (§5.3). The template is the default; the model may only re-word the
 * same facts. Its output goes through the same grounding as everything else (§68), and any failure
 * (model down, bad output, an unsupported claim) means the caller sends the template instead.
 * The model never edits a blocked draft into shape and is never asked twice for the same reply.
 */
import { ground, type GroundedDraft, type GroundingFailure, type GroundingSources } from '@sevari/grounding';
import type { Intent } from '@sevari/domain';
import type { StyleProfile } from './prompts.ts';
import type { LlmProvider } from './provider.ts';
import { wordReply, type ModelTrace } from './tasks.ts';

/** Which intents a tenant has opted in to model wording for. Default: none (templates only). */
export interface WordingPolicy {
  readonly modelWordingIntents: readonly Intent[];
}

export type ModelDraftResult =
  | { readonly kind: 'model'; readonly draft: GroundedDraft; readonly trace: ModelTrace }
  | { readonly kind: 'use_template'; readonly reason: 'not_opted_in' | 'no_model' | 'model_error' | 'invalid_output' | 'grounding_blocked'; readonly failures: readonly GroundingFailure[]; readonly trace: ModelTrace | null };

export async function modelDraft(input: {
  readonly intent: Intent;
  readonly policy: WordingPolicy;
  readonly model: LlmProvider | null;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly style: StyleProfile;
  readonly sources: GroundingSources;
  readonly ctx: { readonly nowMs: number; readonly timezone: string };
  readonly timeoutMs?: number;
}): Promise<ModelDraftResult> {
  if (!input.policy.modelWordingIntents.includes(input.intent)) return { kind: 'use_template', reason: 'not_opted_in', failures: [], trace: null };
  if (!input.model) return { kind: 'use_template', reason: 'no_model', failures: [], trace: null };
  const w = await wordReply(input.model, input.facts, input.style, input.sources.customerText, input.timeoutMs ? { timeoutMs: input.timeoutMs } : {});
  if (w.trace.outcome === 'error') return { kind: 'use_template', reason: 'model_error', failures: [], trace: w.trace };
  if (w.text === null) return { kind: 'use_template', reason: 'invalid_output', failures: [], trace: w.trace };
  const g = ground(w.text, 'reply', input.sources, input.ctx);
  if (!g.ok) return { kind: 'use_template', reason: 'grounding_blocked', failures: g.failures, trace: w.trace };
  return { kind: 'model', draft: g.draft, trace: w.trace };
}
