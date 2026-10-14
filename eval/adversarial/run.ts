/** Shared runner for adversarial grounding cases (dev set and holdout use the same harness). */
import { ground, type ServiceFact } from '@sevari/grounding';

export interface AdversarialCase {
  id: string; category: string; facts: string[]; services: ServiceFact[]; customer: string; draft: string; expect: 'block' | 'pass';
}

const CTX = { nowMs: Date.parse('2026-10-14T09:00:00Z'), timezone: 'Europe/London' };

export function judge(c: AdversarialCase): { id: string; category: string; expect: string; got: 'block' | 'pass'; rules: string[] } {
  const r = ground(c.draft, 'reply', { factTexts: c.facts, factIds: ['fact@1'], customerText: c.customer, services: c.services }, CTX);
  return { id: c.id, category: c.category, expect: c.expect, got: r.ok ? 'pass' : 'block', rules: r.ok ? [] : [...new Set(r.failures.map((f) => f.rule))] };
}

export function parseCases(jsonl: string): AdversarialCase[] {
  return jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l) as AdversarialCase);
}
