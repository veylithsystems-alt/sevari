/**
 * Grounding (contract §5.2, §5.3, INV-5, F3). The ONLY place a GroundedDraft can be made: the brand
 * symbol is private to this module and the lint rule sevari/no-grounded-draft-forgery stops casts
 * elsewhere. Channel adapters accept only GroundedDraft, so ungrounded text can't reach a customer.
 *
 * Rules:
 *  - Every claim in the draft (money, %, dates, times, phones, emails, hosts, postcodes, numbers) must
 *    be supported by an authorised fact or appear in the customer's own message.
 *  - No special-category reference unless the customer raised it (§8.4).
 *  - Service and acknowledgement messages contain no marketing language (§50.3, §23).
 *  - The model never certifies itself (§68): this is deterministic and blocks; it never edits.
 */
import { normaliseForMatch, hasPhrase } from '@sevari/domain';
import { claimKey, extractClaims, type Claim, type ExtractContext } from './claims.ts';
import { checkCommitments, checkServiceClaims, type ServiceFact } from './semantic.ts';

declare const groundedBrand: unique symbol;
const GROUNDED: unique symbol = Symbol('sevari.grounded');

export type MessagePurpose = 'ack' | 'safety' | 'holding' | 'clarify' | 'reply' | 'marketing';

export interface GroundedDraft {
  readonly text: string;
  readonly purpose: MessagePurpose;
  readonly claims: readonly Claim[];
  readonly factsUsed: readonly string[];
  readonly [groundedBrand]: true;
}

export interface GroundingSources {
  /** Text of every authorised fact the draft may use (knowledge records, computed windows, templates' fixed wording). */
  readonly factTexts: readonly string[];
  /** Citations for factsUsed (record id@version). */
  readonly factIds: readonly string[];
  /** The customer's own words: values they gave may be echoed back. */
  readonly customerText: string;
  /** Structured service facts, for "we do / we don't do" claims (§68). */
  readonly services?: readonly ServiceFact[];
}

export interface GroundingFailure {
  readonly rule: 'unsupported_claim' | 'special_category' | 'marketing_language' | 'empty' | 'service_claim' | 'commitment';
  readonly detail: string;
}

export type GroundingResult =
  | { readonly ok: true; readonly draft: GroundedDraft }
  | { readonly ok: false; readonly failures: readonly GroundingFailure[]; readonly claims: readonly Claim[] };

const SPECIAL = ['pregnant', 'pregnancy', 'cancer', 'hiv', 'disabled', 'disability', 'dementia', 'mental health', 'religion', 'muslim', 'christian', 'jewish', 'sikh', 'hindu', 'gay', 'lesbian', 'bisexual', 'transgender', 'trade union', 'criminal record', 'ethnicity', 'race'];
const MARKETING = ['special offer', 'offer ends', 'discount', 'sale', 'deal', 'deals', 'promotion', 'promo', 'limited time', 'special price', 'exclusive', 'free gift', 'voucher', 'subscribe', 'newsletter', 'follow us', 'refer a friend', '% off', 'percent off', 'book now and save'];

export function ground(text: string, purpose: MessagePurpose, sources: GroundingSources, ctx: ExtractContext): GroundingResult {
  const failures: GroundingFailure[] = [];
  const claims = extractClaims(text, ctx);
  if (!text.trim()) failures.push({ rule: 'empty', detail: 'empty message' });

  const supported = new Set<string>();
  for (const t of [...sources.factTexts, sources.customerText]) for (const c of extractClaims(t, ctx)) supported.add(claimKey(c));
  // No cross-kind support: "£60 an hour" supports "£60 an hour", never a bare "60" ("60 engineers").
  for (const c of claims) {
    if (!supported.has(claimKey(c))) failures.push({ rule: 'unsupported_claim', detail: `${c.kind} "${c.raw}" is not in the authorised facts or the customer's message` });
  }

  const draftN = normaliseForMatch(text);
  const customerN = normaliseForMatch(sources.customerText);
  for (const term of SPECIAL) {
    if (hasPhrase(draftN, term) && !hasPhrase(customerN, term)) failures.push({ rule: 'special_category', detail: `mentions "${term}", which the customer did not raise` });
  }
  if (purpose !== 'marketing') {
    const factN = normaliseForMatch(sources.factTexts.join(' \n '));
    for (const term of MARKETING) {
      const inDraft = term.includes('%') ? text.toLowerCase().includes(term) : hasPhrase(draftN, term);
      if (inDraft && !hasPhrase(factN, term)) failures.push({ rule: 'marketing_language', detail: `service messages can't contain "${term}"` });
    }
  }

  failures.push(...checkServiceClaims(text, sources.services ?? []));
  failures.push(...checkCommitments(text, sources.factTexts.join(' \n ')));

  if (failures.length) return { ok: false, failures, claims };
  const draft = { text, purpose, claims, factsUsed: [...sources.factIds], [GROUNDED]: true } as unknown as GroundedDraft;
  return { ok: true, draft };
}

/** Runtime check for values crossing a process boundary (e.g. read back from the outbox). */
export function isGroundedDraft(v: unknown): v is GroundedDraft {
  return typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[GROUNDED] === true;
}

export { extractClaims, claimKey, type Claim, type ClaimKind } from './claims.ts';
export { COMMITMENTS, type ServiceFact } from './semantic.ts';
