/**
 * Semantic claims the number extractor can't see (Part J §68: material claims are compared claim by
 * claim against the authorised source):
 *   - service claims with polarity: "we do jetting" vs "we don't do jetting" must match the records;
 *   - commitments and remedies ("guarantee", "same day", "free", "refund", "fully insured"...) must
 *     appear in the authorised facts, word for word.
 */
import { matchesKeyword, stemTokens } from '@sevari/domain';

export interface ServiceFact {
  readonly code: string;
  readonly names: readonly string[];
  readonly offered: boolean;
}

export interface SemanticFailure {
  readonly rule: 'service_claim' | 'commitment';
  readonly detail: string;
}

const NEGATIONS = new Set(['not', 'no', 'dont', 'doesnt', 'cant', 'cannot', 'unable', 'never', 'wont', 'arent', 'isnt', 'unfortunately']);

/** Material commitments and remedies (§20.3: the model never invents compensation). */
export const COMMITMENTS: readonly string[] = [
  'guarantee', 'guaranteed', 'warranty', 'same day', 'within the hour', 'within an hour', 'next day', 'free of charge', 'free', 'no charge',
  'no call out fee', 'no callout fee', 'no fix no fee', 'refund', 'money back', 'compensation', 'credit', 'discount', 'fully insured', 'insured',
  'accredited', 'certified', 'approved', 'registered', 'licensed', 'qualified', 'promise', 'definitely', 'always', '24 hours', '24/7', '24 7',
  'waive', 'waived', 'goodwill', 'no cost', 'at no cost', 'on the house', 'half price', 'unlimited', 'cheapest', 'lowest price', 'price match',
  'cash price', 'cash discount', 'covered', 'included', 'includes', 'all inclusive',
];

export function checkServiceClaims(draft: string, services: readonly ServiceFact[]): SemanticFailure[] {
  const tokens = stemTokens(draft);
  const failures: SemanticFailure[] = [];
  for (const s of services) {
    const mentioned = s.names.filter((n) => matchesKeyword(tokens, n));
    if (mentioned.length === 0) continue;
    const negated = mentioned.some((n) => isNegatedMention(tokens, n));
    if (s.offered && negated) failures.push({ rule: 'service_claim', detail: `says "${mentioned[0]}" is not offered, but the records say it is` });
    if (!s.offered && !negated) failures.push({ rule: 'service_claim', detail: `implies "${mentioned[0]}" is offered, but the records say it is not` });
  }
  return failures;
}

function isNegatedMention(tokens: readonly string[], name: string): boolean {
  const first = stemTokens(name)[0];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== first) continue;
    const before = tokens.slice(Math.max(0, i - 5), i);
    if (before.some((t) => NEGATIONS.has(t))) return true;
  }
  return false;
}

export function checkCommitments(draft: string, factText: string): SemanticFailure[] {
  const d = ` ${stemTokens(draft).join(' ')} `;
  const f = ` ${stemTokens(factText).join(' ')} `;
  const failures: SemanticFailure[] = [];
  for (const c of COMMITMENTS) {
    const k = ` ${stemTokens(c).join(' ')} `;
    if (k.trim() && d.includes(k) && !f.includes(k)) failures.push({ rule: 'commitment', detail: `commits to "${c}", which the records don't state` });
  }
  return failures;
}
