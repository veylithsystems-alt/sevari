/**
 * The onboarding interview (§18 step 2, §81.1, §83.2). The owner's answers become:
 *   - typed knowledge records (business, services, prices, hours, area, policies, FAQs), each previewed and
 *     confirmed by the owner before it counts (I5);
 *   - a drafted pack for any kind of service business: their services with the everyday words customers
 *     use, and the questions to ask. The generic intents (price, booking, complaint, opt-out...) come from
 *     the core, so a new kind of business needs no code.
 * Pure: no database, no clock.
 */
import { z } from 'zod';
import { parseKnowledge, type AnyKnowledge, type VerticalPack } from '@sevari/domain';
import { COMMON_QUESTIONS, SAFETY_999, packFor } from '@sevari/verticals';

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Day = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

const PriceAnswer = z.discriminatedUnion('basis', [
  z.object({ basis: z.literal('on_inspection') }),
  z.object({ basis: z.enum(['fixed', 'from', 'per_hour', 'call_out']), pounds: z.number().nonnegative() }),
  z.object({ basis: z.literal('range'), pounds: z.number().nonnegative(), max_pounds: z.number().nonnegative() }),
]);

export const InterviewAnswers = z.object({
  business: z.object({
    trading_name: z.string().min(1).max(120),
    phone: z.string().max(40).optional(),
    email: z.string().email().optional(),
    website: z.string().url().optional(),
    privacy_notice_url: z.string().url(),
    reply_time_statement: z.string().min(1).max(120),
    /** In their own words: what the business does. Read for regulated activities (§83.4). */
    description: z.string().min(3).max(1_000),
    /** One of the ready-made trade packs, if it fits; otherwise Sevari drafts one. */
    trade: z.string().optional(),
    vat: z.enum(['inclusive', 'exclusive', 'not_registered']),
  }),
  services: z.array(z.object({
    name: z.string().min(2).max(120),
    /** The words customers actually use ("blocked loo", "toilet won't flush"). */
    everyday_names: z.array(z.string().min(2).max(60)).default([]),
    price: PriceAnswer,
    price_conditions: z.string().max(300).optional(),
    emergency: z.boolean().default(false),
  })).min(1),
  not_offered: z.array(z.string().min(2).max(120)).default([]),
  hours: z.object({
    weekly: z.record(Day, z.array(z.object({ start: Hhmm, end: Hhmm }))),
    timezone: z.string().default('Europe/London'),
    emergency_always: z.boolean().default(false),
  }),
  area: z.object({
    outward_codes: z.array(z.string().regex(/^[A-Z]{1,2}\d[A-Z\d]?$/)).default([]),
    postcode_areas: z.array(z.string().regex(/^[A-Z]{1,2}$/)).default([]),
    description: z.string().min(2).max(300),
  }),
  policies: z.array(z.object({ topic: z.enum(['cancellation', 'deposit', 'guarantee', 'payment', 'complaints', 'resolution', 'call_out', 'other']), text: z.string().min(1).max(2_000) })).default([]),
  faqs: z.array(z.object({ question: z.string().min(1).max(300), answer: z.string().min(1).max(2_000), keywords: z.array(z.string().min(2).max(60)).min(1) })).default([]),
});
export type InterviewAnswers = z.infer<typeof InterviewAnswers>;

export interface Draft {
  /** Knowledge records to propose; each becomes real only when the owner confirms it. */
  readonly records: readonly AnyKnowledge[];
  /** The pack: a ready-made trade pack, or one drafted for this business. */
  readonly pack: VerticalPack;
  /** True when the pack was drafted (it needs the owner's confirmation and its tests, T-PACK-1). */
  readonly drafted: boolean;
}

export const codeFor = (name: string): string => {
  const c = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return /^[a-z]/.test(c) ? c : `s_${c}`;
};
const toMinor = (pounds: number) => Math.round(pounds * 100);
const orList = (xs: readonly string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}` : xs[0] ?? '');

export function draftFromAnswers(raw: unknown): Draft {
  const a = InterviewAnswers.parse(raw);
  const known = a.business.trade ? tryPack(a.business.trade) : null;
  const services = uniqueCodes(a.services.map((s) => ({ ...s, code: codeFor(s.name) })));
  const records: AnyKnowledge[] = [
    parseKnowledge({
      kind: 'business', trading_name: a.business.trading_name, privacy_notice_url: a.business.privacy_notice_url, reply_time_statement: a.business.reply_time_statement,
      vertical: known ? known.id : 'custom',
      ...(a.business.phone ? { phone: a.business.phone } : {}), ...(a.business.email ? { email: a.business.email } : {}), ...(a.business.website ? { website: a.business.website } : {}),
    }),
    parseKnowledge({ kind: 'hours', timezone: a.hours.timezone, weekly: a.hours.weekly, emergency: { available: a.hours.emergency_always || services.some((s) => s.emergency), always: a.hours.emergency_always } }),
    parseKnowledge({ kind: 'area', outward_codes: a.area.outward_codes, postcode_areas: a.area.postcode_areas, description: a.area.description }),
  ];
  for (const s of services) {
    records.push(parseKnowledge({ kind: 'service', code: s.code, name: s.name, keywords: s.everyday_names, offered: true, emergency: s.emergency }));
    const p = s.price;
    records.push(parseKnowledge({
      kind: 'price', service_code: s.code, basis: p.basis, vat: a.business.vat,
      ...(p.basis !== 'on_inspection' ? { amount_minor: toMinor(p.pounds) } : {}), ...(p.basis === 'range' ? { max_minor: toMinor(p.max_pounds) } : {}),
      ...(s.price_conditions ? { conditions: s.price_conditions } : {}),
    }));
  }
  for (const n of a.not_offered) records.push(parseKnowledge({ kind: 'service', code: codeFor(n), name: n, keywords: [], offered: false }));
  for (const p of a.policies) records.push(parseKnowledge({ kind: 'policy', topic: p.topic, text: p.text }));
  for (const f of a.faqs) records.push(parseKnowledge({ kind: 'faq', ...f }));
  if (known) return { records, pack: known, drafted: false };

  const pack: VerticalPack = {
    id: `custom:${codeFor(a.business.trading_name)}`, name: a.business.trading_name, version: '1', regulated: false,
    emergencyTrade: services.some((s) => s.emergency),
    services: services.map((s) => ({ code: s.code, name: s.name, emergency: s.emergency, keywords: [...new Set([s.name.toLowerCase(), ...s.everyday_names.map((k) => k.toLowerCase())])] })),
    intentRules: [],
    clarifyingQuestions: { ...COMMON_QUESTIONS, service: `Could you tell us which of these you need: ${orList(services.map((s) => s.name))}?` },
    ...(services.some((s) => s.emergency) ? { safetyMessage: SAFETY_999 } : {}),
  };
  return { records, pack, drafted: true };
}

function tryPack(id: string): VerticalPack | null {
  try { return packFor(id); } catch { return null; }
}
function uniqueCodes<T extends { code: string }>(xs: T[]): T[] {
  const seen = new Map<string, number>();
  return xs.map((x) => {
    const n = (seen.get(x.code) ?? 0) + 1;
    seen.set(x.code, n);
    return n === 1 ? x : { ...x, code: `${x.code}_${n}` };
  });
}
