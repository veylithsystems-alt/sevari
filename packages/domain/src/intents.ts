/**
 * Rules-first intent classification (§5.3). Generic rules plus the pack's rules; whole-word matching;
 * negation-aware; confidence recorded; abstains rather than guesses (the model is consulted only on
 * abstain, Phase 5, and only within a constrained enum).
 */
import type { IntentRule, Intent, VerticalPack } from './pack.ts';
import { hasAffirmed, matchesKeyword, normaliseForMatch, stemTokens } from './text.ts';
import type { SensitiveFlag } from './sensitive.ts';

export const GENERIC_INTENT_RULES: readonly IntentRule[] = [
  { intent: 'emergency', phrases: [{ p: 'emergency', w: 4 }, { p: 'urgent', w: 2 }, { p: 'asap', w: 2 }, { p: 'right now', w: 2 }, { p: 'immediately', w: 2 }, { p: 'as soon as possible', w: 2 }] },
  { intent: 'quote_request', phrases: [{ p: 'give me a price', w: 4 }, { p: 'quote', w: 3 }, { p: 'quotation', w: 3 }, { p: 'estimate', w: 3 }, { p: 'how much would', w: 2 }, { p: 'price up', w: 3 }, { p: 'come and look', w: 3 }, { p: 'come and have a look', w: 3 }, { p: 'survey', w: 2 }] },
  { intent: 'booking_request', phrases: [{ p: 'book', w: 3 }, { p: 'booking', w: 3 }, { p: 'appointment', w: 3 }, { p: 'can you come', w: 3 }, { p: 'could you come', w: 3 }, { p: 'send someone', w: 3 }, { p: 'visit', w: 1 }, { p: 'can someone come', w: 3 }, { p: 'able to come', w: 3 }, { p: 'come out', w: 2 }, { p: 'take a look', w: 3 }, { p: 'have a look', w: 2 }, { p: 'can you fix', w: 3 }, { p: 'when can you', w: 3 }, { p: 'go ahead', w: 3 }, { p: 'need someone', w: 2 }, { p: 'can you help', w: 2 }] },
  { intent: 'availability_question', phrases: [{ p: 'are you available', w: 3 }, { p: 'when are you free', w: 3 }, { p: 'are you free', w: 4 }, { p: 'anyone available', w: 4 }, { p: 'earliest', w: 4 }, { p: 'do you have any availability', w: 4 }, { p: 'how soon', w: 2 }, { p: 'any slots', w: 3 }] },
  { intent: 'price_question', phrases: [{ p: 'how much', w: 3 }, { p: 'price', w: 2 }, { p: 'cost', w: 2 }, { p: 'charge', w: 2 }, { p: 'call out fee', w: 3 }, { p: 'callout fee', w: 3 }, { p: 'call out charge', w: 3 }, { p: 'rates', w: 2 }] },
  { intent: 'service_question', phrases: [{ p: 'do you do', w: 3 }, { p: 'do you fix', w: 3 }, { p: 'do you cover', w: 3 }, { p: 'do you offer', w: 3 }, { p: 'do you work in', w: 3 }, { p: 'do you', w: 2 }] },
  { intent: 'reschedule', phrases: [{ p: 'reschedule', w: 4 }, { p: 'rearrange', w: 4 }, { p: 'move my appointment', w: 4 }, { p: 'change my booking', w: 4 }, { p: 'different day', w: 2 }] },
  { intent: 'cancel', phrases: [{ p: 'cancel my', w: 4 }, { p: 'cancel the', w: 4 }, { p: 'no longer need', w: 4 }, { p: "don't need you", w: 3 }, { p: 'cancellation', w: 3 }] },
  { intent: 'complaint', phrases: [{ p: 'complaint', w: 5 }, { p: 'complain', w: 5 }, { p: 'not happy', w: 4 }, { p: 'unhappy', w: 4 }, { p: 'disappointed', w: 3 }, { p: 'refund', w: 4 }, { p: 'still not fixed', w: 4 }, { p: 'came back worse', w: 4 }, { p: 'unacceptable', w: 3 }] },
  { intent: 'data_rights', phrases: [{ p: 'subject access', w: 6 }, { p: 'delete my data', w: 6 }, { p: 'my personal data', w: 5 }, { p: 'personal data', w: 5 }, { p: 'data you hold', w: 6 }, { p: 'information you hold', w: 6 }, { p: 'delete my details', w: 6 }, { p: 'copy of my data', w: 6 }, { p: 'forget me', w: 5 }, { p: 'gdpr', w: 5 }, { p: 'data protection', w: 5 }, { p: 'right to be forgotten', w: 6 }] },
  { intent: 'opt_out', phrases: [{ p: 'unsubscribe', w: 6 }, { p: 'stop texting', w: 6 }, { p: 'stop messaging', w: 6 }, { p: 'stop contacting', w: 6 }, { p: 'remove me', w: 5 }, { p: 'opt out', w: 6 }] },
  { intent: 'follow_up', phrases: [{ p: 'following up', w: 4 }, { p: 'any update', w: 4 }, { p: 'any news', w: 4 }, { p: 'chasing', w: 4 }, { p: 'heard nothing', w: 4 }, { p: "haven't heard", w: 4 }, { p: 'still waiting', w: 4 }, { p: 'did you get my', w: 4 }] },
  { intent: 'thanks', phrases: [{ p: 'thank you', w: 2 }, { p: 'thanks', w: 2 }, { p: 'cheers', w: 2 }, { p: 'brilliant job', w: 3 }, { p: 'great job', w: 3 }, { p: 'lovely job', w: 3 }, { p: 'looks great', w: 3 }, { p: 'works perfect', w: 3 }] },
];

/** Intents that outrank every other reading once they reach these scores (safety and rights first). */
const DOMINANT: ReadonlyArray<[Intent, number]> = [['data_rights', 2], ['opt_out', 2], ['complaint', 3], ['emergency', 4]];

/** Escalation signals imply the intent, whatever the wording (§20.1 recall). */
const FLAG_INTENT: ReadonlyArray<[SensitiveFlag, Intent]> = [
  ['opt_out', 'opt_out'], ['data_rights', 'data_rights'], ['legal_threat', 'complaint'], ['regulator', 'complaint'],
  ['injury_or_damage', 'complaint'], ['discrimination', 'complaint'], ['complaint', 'complaint'], ['risk_to_life', 'emergency'],
];

export interface IntentResult {
  readonly intent: Intent;
  /** 0..1. Rules confidence: margin of the winner over the runner-up. */
  readonly confidence: number;
  readonly abstained: boolean;
  readonly scores: Readonly<Partial<Record<Intent, number>>>;
  readonly matched: readonly string[];
  readonly source: 'rules' | 'model';
  /** Set when source is 'model' (§32 lineage). */
  readonly model?: { readonly modelId: string; readonly promptId: string };
}

/** A model's label for a message the rules abstained on (Phase 5). */
export interface ModelIntent {
  readonly intent: Intent;
  readonly confidence: number;
  readonly modelId: string;
  readonly promptId: string;
}

/**
 * Intents a model may never act on by itself: STOP, risk to life, data rights and complaints are
 * decided by deterministic rules or a human. A model label of one of these sends the case to a person.
 */
export const MODEL_ESCALATE_INTENTS: ReadonlySet<Intent> = new Set(['opt_out', 'emergency', 'data_rights', 'complaint']);

/** Uses the model's label only when the rules abstained and the model did not (§5.3: rules first). */
export function withModelFallback(rules: IntentResult, model: ModelIntent | undefined): IntentResult {
  if (!rules.abstained || !model || model.intent === 'other') return rules;
  return {
    intent: model.intent, confidence: Math.min(1, Math.max(0, model.confidence)), abstained: false, scores: rules.scores,
    matched: [...rules.matched, `model:${model.modelId}`], source: 'model', model: { modelId: model.modelId, promptId: model.promptId },
  };
}

export function classifyIntent(text: string, pack: VerticalPack, opts: { minScore?: number; minMargin?: number; flags?: readonly SensitiveFlag[] } = {}): IntentResult {
  const h = normaliseForMatch(text);
  const scores: Partial<Record<Intent, number>> = {};
  const matched: string[] = [];
  for (const rule of [...GENERIC_INTENT_RULES, ...pack.intentRules]) {
    for (const { p, w } of rule.phrases) {
      if (hasAffirmed(h, p)) {
        scores[rule.intent] = (scores[rule.intent] ?? 0) + w;
        matched.push(`${rule.intent}:${p}`);
      }
    }
  }
  const minScore = opts.minScore ?? 2;
  const minMargin = opts.minMargin ?? 1;
  const ranked = (Object.entries(scores) as [Intent, number][]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const flagged = FLAG_INTENT.find(([f]) => opts.flags?.includes(f));
  if (flagged) return { intent: flagged[1], confidence: 1, abstained: false, scores, matched: [...matched, `flag:${flagged[0]}`], source: 'rules' };
  const dominant = DOMINANT.find(([d, min]) => (scores[d] ?? 0) >= min)?.[0];
  const top = dominant ? ([dominant, scores[dominant] ?? 0] as [Intent, number]) : ranked[0];
  if (!top || top[1] < minScore) return { intent: 'other', confidence: 0, abstained: true, scores, matched, source: 'rules' };
  const runnerUp = ranked.find(([i]) => i !== top[0])?.[1] ?? 0;
  const margin = top[1] - runnerUp;
  // "thanks" alongside anything substantive is not a thank-you note.
  if (top[0] === 'thanks' && ranked.length > 1) {
    const next = ranked.find(([i]) => i !== 'thanks');
    if (next && next[1] >= minScore) return { intent: next[0], confidence: round(next[1] / (next[1] + 1)), abstained: false, scores, matched, source: 'rules' };
  }
  const abstained = !dominant && margin < minMargin;
  return { intent: abstained ? 'other' : top[0], confidence: abstained ? 0 : round(margin / (margin + 2) + (dominant ? 0.25 : 0)), abstained, scores, matched, source: 'rules' };
}

const round = (n: number) => Math.min(1, Math.round(n * 100) / 100);

/** Which of the pack's (and the tenant's) services the customer is asking about. */
export function detectServices(text: string, services: readonly { code: string; keywords: readonly string[]; name: string }[]): string[] {
  const tokens = stemTokens(text);
  // Longer, more specific keywords weigh more than single words.
  const hits = services.map((s) => ({
    code: s.code,
    // Synonyms that stem to the same words ("drain", "drains") count once.
    score: [...new Map([s.name, ...s.keywords].map((k) => [stemTokens(k).join(' '), k] as const)).entries()]
      .filter(([, k]) => matchesKeyword(tokens, k)).reduce((acc, [key]) => acc + key.split(' ').length, 0),
  })).filter((x) => x.score > 0);
  return hits.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code)).map((x) => x.code);
}
