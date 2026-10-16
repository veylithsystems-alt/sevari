/**
 * The two things a model may do (§5.3):
 *   classifyIntent  only when the rules abstain; output must be in the enum or it's an abstain.
 *   wordReply       only for intents opted in to model wording; output then goes to grounding, which
 *                   blocks anything unsupported (the model never certifies itself, §68).
 * Every failure (timeout, bad schema, model down) degrades to the deterministic path (§36.2).
 */
import { z } from 'zod';
import { INTENTS, type Intent } from '@sevari/domain';
import { classifyPrompt, PROMPTS, wordingPrompt, type StyleProfile } from './prompts.ts';
import type { LlmProvider } from './provider.ts';

export interface ModelTrace {
  readonly modelId: string;
  readonly promptId: string;
  readonly tokens: number;
  readonly latencyMs: number;
  readonly outcome: 'ok' | 'invalid_output' | 'error';
}

const IntentOut = z.object({ intent: z.enum(INTENTS), confidence: z.number().min(0).max(1) }).strict();
const ReplyOut = z.object({ reply: z.string().min(1).max(1200) }).strict();

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function classifyIntent(p: LlmProvider, customerText: string, opts: { timeoutMs?: number; minConfidence?: number } = {}):
  Promise<{ intent: Intent; confidence: number; abstained: boolean; trace: ModelTrace }> {
  const pr = classifyPrompt(customerText);
  try {
    const r = await p.generate({ task: 'classify_intent', promptId: PROMPTS.classify_intent, ...pr, maxTokens: 40, timeoutMs: opts.timeoutMs ?? 15_000 });
    const parsed = IntentOut.safeParse(parseJson(r.raw));
    const trace = { modelId: r.modelId, promptId: PROMPTS.classify_intent, tokens: r.promptTokens + r.outputTokens, latencyMs: r.latencyMs };
    if (!parsed.success) return { intent: 'other', confidence: 0, abstained: true, trace: { ...trace, outcome: 'invalid_output' } };
    const low = parsed.data.confidence < (opts.minConfidence ?? 0.6) || parsed.data.intent === 'other';
    return { intent: low ? 'other' : parsed.data.intent, confidence: parsed.data.confidence, abstained: low, trace: { ...trace, outcome: 'ok' } };
  } catch {
    return { intent: 'other', confidence: 0, abstained: true, trace: { modelId: p.modelId, promptId: PROMPTS.classify_intent, tokens: 0, latencyMs: 0, outcome: 'error' } };
  }
}

export async function wordReply(p: LlmProvider, facts: Readonly<Record<string, unknown>>, style: StyleProfile, customerText: string, opts: { timeoutMs?: number } = {}):
  Promise<{ text: string | null; trace: ModelTrace }> {
  const pr = wordingPrompt(facts, style, customerText);
  try {
    const r = await p.generate({ task: 'word_reply', promptId: PROMPTS.word_reply, ...pr, maxTokens: 400, timeoutMs: opts.timeoutMs ?? 60_000 });
    const parsed = ReplyOut.safeParse(parseJson(r.raw));
    const trace = { modelId: r.modelId, promptId: PROMPTS.word_reply, tokens: r.promptTokens + r.outputTokens, latencyMs: r.latencyMs };
    return parsed.success ? { text: parsed.data.reply, trace: { ...trace, outcome: 'ok' } } : { text: null, trace: { ...trace, outcome: 'invalid_output' } };
  } catch {
    return { text: null, trace: { modelId: p.modelId, promptId: PROMPTS.word_reply, tokens: 0, latencyMs: 0, outcome: 'error' } };
  }
}
