/**
 * Typed owner knowledge (§6.2 knowledge_records, I5). Every fact the system may state comes from one
 * of these records, confirmed by the owner, versioned, with an effective period. Pure schemas only.
 */
import { z } from 'zod';

const Code = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Window = z.object({ start: Hhmm, end: Hhmm }).refine((w) => w.start < w.end, 'window start must be before end');
const Day = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

export const ServiceRecord = z.object({
  kind: z.literal('service'),
  code: Code,
  name: z.string().min(1).max(120),
  /** Extra words customers use for this service, on top of the vertical pack's. */
  keywords: z.array(z.string().min(2).max(60)).default([]),
  offered: z.boolean(),
  emergency: z.boolean().default(false),
});

export const PriceRecord = z.object({
  kind: z.literal('price'),
  service_code: Code,
  /** price on inspection is a valid, grounded answer (§42). */
  basis: z.enum(['fixed', 'from', 'range', 'per_hour', 'on_inspection', 'call_out']),
  amount_minor: z.number().int().nonnegative().optional(),
  max_minor: z.number().int().nonnegative().optional(),
  currency: z.enum(['GBP', 'EUR', 'USD']).default('GBP'),
  /** VAT treatment is the owner's confirmed record, never decided by Sevari (§19.2). */
  vat: z.enum(['inclusive', 'exclusive', 'not_registered']),
  conditions: z.string().max(300).optional(),
}).superRefine((p, ctx) => {
  const needsAmount = p.basis !== 'on_inspection';
  if (needsAmount && p.amount_minor === undefined) ctx.addIssue({ code: 'custom', message: `${p.basis} price needs amount_minor` });
  if (p.basis === 'range' && (p.max_minor === undefined || p.max_minor < (p.amount_minor ?? 0))) ctx.addIssue({ code: 'custom', message: 'range needs max_minor >= amount_minor' });
  if (p.basis === 'on_inspection' && p.amount_minor !== undefined) ctx.addIssue({ code: 'custom', message: 'on_inspection carries no amount' });
});

export const HoursRecord = z.object({
  kind: z.literal('hours'),
  timezone: z.string().default('Europe/London'),
  weekly: z.record(Day, z.array(Window)),
  emergency: z.object({ available: z.boolean(), always: z.boolean().default(false), windows: z.record(Day, z.array(Window)).default({}) }),
  closed_dates: z.array(z.string().date()).default([]),
});

export const AreaRecord = z.object({
  kind: z.literal('area'),
  /** UK outward codes (CH65) or postcode areas (CH). Matching is by outward code first, then area. */
  outward_codes: z.array(z.string().regex(/^[A-Z]{1,2}\d[A-Z\d]?$/)).default([]),
  postcode_areas: z.array(z.string().regex(/^[A-Z]{1,2}$/)).default([]),
  description: z.string().max(300),
});

export const PolicyRecord = z.object({
  kind: z.literal('policy'),
  topic: z.enum(['cancellation', 'deposit', 'guarantee', 'payment', 'complaints', 'resolution', 'call_out', 'other']),
  text: z.string().min(1).max(2_000),
});

/**
 * The business's resolution policy (§20.3): which remedies it offers for a complaint, and the limits. A
 * remedy outside this is the owner's decision; the model never invents compensation.
 */
export const ResolutionPolicyRecord = z.object({
  kind: z.literal('resolution_policy'),
  /** Days to give a full response to a complaint, stated to the customer (the complaint clock). */
  response_days: z.number().int().min(1).max(60),
  remedies: z.array(z.object({
    type: z.enum(['apology', 'redo', 'partial_credit', 'refund']),
    /** Upper limit in minor units (credit or refund). Absent for apology and redo. */
    max_minor: z.number().int().positive().optional(),
    conditions: z.string().min(1).max(300),
  })).min(1),
}).superRefine((r, ctx) => {
  for (const m of r.remedies) if ((m.type === 'partial_credit' || m.type === 'refund') && m.max_minor === undefined) ctx.addIssue({ code: 'custom', message: `${m.type} needs a max_minor limit` });
});

export const FaqRecord = z.object({
  kind: z.literal('faq'),
  question: z.string().min(1).max(300),
  answer: z.string().min(1).max(2_000),
  keywords: z.array(z.string().min(2).max(60)).min(1),
});

export const BusinessRecord = z.object({
  kind: z.literal('business'),
  trading_name: z.string().min(1).max(120),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional(),
  website: z.string().url().optional(),
  privacy_notice_url: z.string().url(),
  /** What the owner promises about reply times, used verbatim (e.g. "within 2 working hours"). */
  reply_time_statement: z.string().min(1).max(120),
  vertical: z.string().min(2).max(40),
});

export type ServiceRecord = z.infer<typeof ServiceRecord>;
export type PriceRecord = z.infer<typeof PriceRecord>;
export type HoursRecord = z.infer<typeof HoursRecord>;
export type AreaRecord = z.infer<typeof AreaRecord>;
export type PolicyRecord = z.infer<typeof PolicyRecord>;
export type FaqRecord = z.infer<typeof FaqRecord>;
export type ResolutionPolicyRecord = z.infer<typeof ResolutionPolicyRecord>;
export type BusinessRecord = z.infer<typeof BusinessRecord>;
export type AnyKnowledge = ServiceRecord | PriceRecord | HoursRecord | AreaRecord | PolicyRecord | FaqRecord | BusinessRecord | ResolutionPolicyRecord;

/** Parse one record body by kind (ZodEffects can't sit inside a discriminated union). */
export function parseKnowledge(body: unknown): AnyKnowledge {
  const kind = (body as { kind?: unknown } | null)?.kind;
  switch (kind) {
    case 'service': return ServiceRecord.parse(body);
    case 'price': return PriceRecord.parse(body);
    case 'hours': return HoursRecord.parse(body);
    case 'area': return AreaRecord.parse(body);
    case 'policy': return PolicyRecord.parse(body);
    case 'faq': return FaqRecord.parse(body);
    case 'resolution_policy': return ResolutionPolicyRecord.parse(body);
    case 'business': return BusinessRecord.parse(body);
    default: throw new Error(`unknown knowledge kind: ${String(kind)}`);
  }
}

/** A record as the core sees it: id + version give every fact a citation (facts_used, §10.2). */
export interface KnowledgeFact<T extends AnyKnowledge = AnyKnowledge> {
  readonly id: string;
  readonly version: number;
  readonly body: T;
}

/** The tenant's current, owner-confirmed knowledge at one moment. */
export interface KnowledgeSnapshot {
  readonly business?: KnowledgeFact<BusinessRecord>;
  readonly services: readonly KnowledgeFact<ServiceRecord>[];
  readonly prices: readonly KnowledgeFact<PriceRecord>[];
  readonly hours?: KnowledgeFact<HoursRecord>;
  readonly areas: readonly KnowledgeFact<AreaRecord>[];
  readonly policies: readonly KnowledgeFact<PolicyRecord>[];
  readonly faqs: readonly KnowledgeFact<FaqRecord>[];
  readonly resolution?: KnowledgeFact<ResolutionPolicyRecord>;
}

export function snapshotFrom(facts: readonly KnowledgeFact[]): KnowledgeSnapshot {
  const of = <K extends AnyKnowledge['kind']>(k: K) => facts.filter((f) => f.body.kind === k) as unknown as KnowledgeFact<Extract<AnyKnowledge, { kind: K }>>[];
  const business = of('business')[0];
  const hours = of('hours')[0];
  const resolution = of('resolution_policy')[0];
  return {
    ...(business ? { business } : {}), ...(hours ? { hours } : {}), ...(resolution ? { resolution } : {}),
    services: of('service'), prices: of('price'), areas: of('area'), policies: of('policy'), faqs: of('faq'),
  };
}
