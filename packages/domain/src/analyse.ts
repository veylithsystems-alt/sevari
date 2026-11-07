/**
 * The deterministic core for one inbound message (§5.2, §5.3, §5.4). Decides WHAT is true and what
 * happens next. The model (Phase 5) may only word what this returns.
 */
import { assessEligibility, type Eligibility } from './eligibility.ts';
import { classifyIntent, detectServices, MODEL_ESCALATE_INTENTS, withModelFallback, type IntentResult, type ModelIntent } from './intents.ts';
import type { KnowledgeSnapshot } from './knowledge.ts';
import type { VerticalPack } from './pack.ts';
import { priceFor, type PriceAnswer } from './pricing.ts';
import { proposeWindows, type Busy, type Window } from './availability.ts';
import { ALWAYS_HUMAN_FLAGS, sensitiveFlags, type SensitiveFlag } from './sensitive.ts';
import type { BookingFact } from './bookings.ts';
import { extractSlots, type Slots } from './slots.ts';
import { hasAffirmed, normaliseForMatch } from './text.ts';

export type Route =
  /** Risk to life: deterministic safety message now, owner alerted (§42). */
  | 'safety_first'
  /** Always-human list (§20.2): holding acknowledgement only, owner escalation with a case file. */
  | 'human_only'
  /** STOP and similar: suppress first, no further sends (§50.3, F39). */
  | 'opt_out'
  /** A specific follow-up question (§30.4); after the limit, escalate. */
  | 'clarify'
  /** Something asked can't be established from records: UNKNOWN (§5.4). */
  | 'unknown'
  /** Everything needed is known: draft a reply (template by default, §5.3). */
  | 'answer';

export interface EnquiryAnalysis {
  readonly intent: IntentResult;
  readonly flags: readonly SensitiveFlag[];
  readonly services: readonly string[];
  readonly slots: Slots;
  readonly eligibility: Eligibility;
  readonly price?: PriceAnswer;
  readonly windows?: readonly Window[];
  readonly faqs: readonly string[];
  /** The customer's upcoming booking, when the message is about it (follow-up, change, cancel). */
  readonly booking?: BookingFact;
  readonly route: Route;
  readonly clarify?: { readonly about: string; readonly question: string };
  /** Citations: knowledge record id@version for every fact the reply may use (§10.2). */
  readonly factsUsed: readonly string[];
  /** What the customer asked about that the records can't answer (§5.4). */
  readonly factsMissing: readonly string[];
}

export interface AnalyseInput {
  readonly text: string;
  readonly subject?: string;
  readonly fromName?: string;
  readonly nowMs: number;
  readonly timezone: string;
  readonly pack: VerticalPack;
  readonly knowledge: KnowledgeSnapshot;
  readonly busy?: readonly Busy[];
  /** This customer's next booking (held or confirmed), if they have one. */
  readonly booking?: BookingFact;
  /** How many clarifying questions this conversation has already had (§30.4). */
  readonly clarificationsSoFar?: number;
  readonly maxClarifications?: number;
  /** The model's label, used only if the rules abstain (Phase 5). The caller asks the model outside any transaction. */
  readonly modelIntent?: ModelIntent;
}

export function analyseEnquiry(input: AnalyseInput): EnquiryAnalysis {
  const text = input.subject ? `${input.subject}\n${input.text}` : input.text;
  const flags = sensitiveFlags(text);
  const intent = withModelFallback(classifyIntent(text, input.pack, { flags }), input.modelIntent);
  const catalogue = mergeCatalogue(input.pack, input.knowledge);
  const services = detectServices(text, catalogue);
  const extracted = extractSlots(input.text, { nowMs: input.nowMs, timezone: input.timezone, ...(input.fromName ? { fromName: input.fromName } : {}) });
  // An emergency is urgent by definition, whatever words were used.
  const slots = intent.intent === 'emergency' && intent.source === 'rules' && !intent.abstained ? { ...extracted, urgency: 'emergency' as const } : extracted;
  const wantsEmergency = (intent.intent === 'emergency' && intent.source === 'rules') || slots.urgency === 'emergency';
  const eligibility = assessEligibility(input.knowledge, { serviceCodes: services, ...(slots.outwardCode ? { outwardCode: slots.outwardCode } : {}), nowMs: input.nowMs, wantsEmergency });
  const h = normaliseForMatch(text);
  const faqs = input.knowledge.faqs.filter((f) => f.body.keywords.some((kw) => hasAffirmed(h, kw))).map((f) => `${f.id}@${f.version}`);

  const factsUsed = new Set<string>(eligibility.factsUsed);
  const factsMissing = new Set<string>();
  faqs.forEach((f) => factsUsed.add(f));
  if (input.knowledge.business) factsUsed.add(`${input.knowledge.business.id}@${input.knowledge.business.version}`);

  const base = { intent, flags, services, slots, eligibility, faqs };
  const done = (route: Route, extra: Partial<EnquiryAnalysis> = {}): EnquiryAnalysis =>
    ({ ...base, ...extra, route, factsUsed: [...factsUsed].sort(), factsMissing: [...factsMissing].sort() });

  // Order matters: safety, then rights and opt-out, then always-human, then the normal path.
  if (flags.includes('risk_to_life')) return done('safety_first');
  // A model never triggers a suppression, a safety message or a rights process by itself: a person decides.
  if (intent.source === 'model' && MODEL_ESCALATE_INTENTS.has(intent.intent)) return done('human_only');
  if (flags.includes('opt_out') || intent.intent === 'opt_out') return done('opt_out');
  if (flags.some((f) => ALWAYS_HUMAN_FLAGS.has(f)) || intent.intent === 'data_rights' || intent.intent === 'complaint') return done('human_only');

  // What did they ask about, and can the records answer it?
  let price: PriceAnswer | undefined;
  if (intent.intent === 'price_question' || intent.intent === 'quote_request') {
    price = priceFor(input.knowledge, services[0] ?? null);
    if (price.kind === 'known') price.factsUsed.forEach((f) => factsUsed.add(f));
    else factsMissing.add(price.missing);
  }
  let windows: readonly Window[] | undefined;
  if (intent.intent === 'booking_request' || intent.intent === 'availability_question' || intent.intent === 'reschedule') {
    const p = proposeWindows(input.knowledge, {
      nowMs: input.nowMs, busy: input.busy ?? [],
      ...(slots.preferredTime?.date ? { preferredDate: slots.preferredTime.date } : {}),
      ...(slots.preferredTime?.partOfDay ? { partOfDay: slots.preferredTime.partOfDay } : {}),
    });
    windows = p.windows;
    p.factsUsed.forEach((f) => factsUsed.add(f));
    p.missing.forEach((m) => factsMissing.add(m));
  }
  eligibility.missing.filter((m) => m.startsWith('knowledge:')).forEach((m) => factsMissing.add(m));
  const extra = { ...(price ? { price } : {}), ...(windows ? { windows } : {}) };

  // Requests about an existing job are answered from the booking record (Phase 9); without one, UNKNOWN.
  if (intent.intent === 'follow_up' || intent.intent === 'reschedule' || intent.intent === 'cancel') {
    if (!input.booking) {
      factsMissing.add('booking_record');
      return done('unknown', extra);
    }
    factsUsed.add(`booking:${input.booking.id}`);
    // A cancellation is answered by a confirmation a person always approves (cancel is never automatic, §7.2).
    const withBooking = { ...extra, booking: input.booking };
    if (intent.intent === 'reschedule' && factsMissing.size > 0) return done('unknown', withBooking);
    return done('answer', withBooking);
  }
  // Clarify what the customer can tell us; UNKNOWN for what only the owner can.
  const required = REQUIRED_SLOTS[intent.intent] ?? [];
  const askable = (intent.abstained ? ['what_needed'] : []).concat(
    eligibility.missing.filter((m) => required.includes(m)),
  );
  const maxClar = input.maxClarifications ?? 2;
  if (askable.length && (input.clarificationsSoFar ?? 0) < maxClar) {
    const about = askable[0] ?? 'what_needed';
    const question = input.pack.clarifyingQuestions[about] ?? input.pack.clarifyingQuestions['what_needed'] ?? 'Could you tell us a little more about what you need?';
    return done('clarify', { ...extra, clarify: { about, question } });
  }
  if (askable.length) {
    // Clarification limit reached: never proceed on a best guess (§30.4, INV-14; reference defect D-5).
    factsMissing.add(`clarification_exhausted:${askable[0]}`);
    return done('unknown', extra);
  }
  if (factsMissing.size > 0) return done('unknown', extra);
  return done('answer', extra);
}

/** What the customer must tell us before we can answer, per intent. */
const REQUIRED_SLOTS: Partial<Record<IntentResult['intent'], readonly string[]>> = {
  emergency: ['service', 'postcode'],
  booking_request: ['service', 'postcode'],
  quote_request: ['service', 'postcode'],
  availability_question: ['service'],
  price_question: ['service'],
  service_question: ['service'],
};

function mergeCatalogue(pack: VerticalPack, k: KnowledgeSnapshot) {
  const byCode = new Map(pack.services.map((s) => [s.code, { code: s.code, name: s.name, keywords: [...s.keywords] }]));
  for (const s of k.services) {
    const existing = byCode.get(s.body.code);
    if (existing) existing.keywords.push(...s.body.keywords);
    else byCode.set(s.body.code, { code: s.body.code, name: s.body.name, keywords: [...s.body.keywords] });
  }
  return [...byCode.values()];
}
