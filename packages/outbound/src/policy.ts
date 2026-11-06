/**
 * The contact-rules gate (Part B §17.2, Phase 10). Every outbound message passes it inside reserve(), in
 * the same transaction and under the same recipient lock as the suppression check, so nothing can slip
 * between the decision and the send. In order:
 *   1. provenance (F10): the contact has a source, basis, time and capturer, from a known, enabled source;
 *   2. tier: the source's tier is enabled in this region (C-E need counsel; F can't exist);
 *   3. purpose limitation: the purpose is allowed for that tier, with a current consent where required;
 *   4. recipient class (F11): corporate-only outreach never reaches anyone treated as an individual;
 *   5. preference registers (F12): marketing by text needs a clear register check (unavailable = no);
 *   6. identity: marketing carries an unsubscribe route and the privacy link;
 *   7. frequency caps and quiet hours (F13): per contact; quiet hours delay, caps refuse.
 * Before all of these: only a business that has gone live messages its customers (§81).
 * Answering someone who wrote in is a "response"; anything else is "proactive". Safety messages and
 * acknowledgements are never delayed or capped.
 */
import { sql, type TenantTx } from '@sevari/db';
import { localParts, localToEpoch, addDays } from '@sevari/domain';
import type { Clock } from '@sevari/clock';
import { z } from 'zod';

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const ContactRulesSchema = z.object({
  timezone: z.string().min(1),
  sending_window: z.object({ start: Hhmm, end: Hhmm }),
  tiers_enabled: z.array(z.enum(['A', 'B', 'C', 'D', 'E'])),
  treat_as_individual: z.array(z.string()),
  preference_registers: z.array(z.string()),
  caps: z.object({ proactive_per_7_days: z.number().int().min(0), marketing_per_30_days: z.number().int().min(0), responses_per_hour: z.number().int().min(1) }),
});
export type ContactRules = z.infer<typeof ContactRulesSchema>;

export type Purpose = 'ack' | 'safety' | 'holding' | 'clarify' | 'reply' | 'marketing';
export type Initiative = 'response' | 'proactive';

/** A do-not-call / preference register (TPS, CTPS, a region's equivalent). No real one is wired yet. */
export interface PreferenceRegister {
  readonly name: string;
  check(channel: 'sms' | 'voice', recipient: string): Promise<'listed' | 'clear' | 'unavailable'>;
}
/** The default: no register is reachable, so anything that needs one is refused (fail closed). */
export const NO_REGISTER: PreferenceRegister = { name: 'none', check: async () => 'unavailable' };

export type PolicyRefusal =
  | 'tenant_not_live' | 'no_provenance' | 'tier_disabled' | 'purpose_not_allowed' | 'no_consent' | 'not_corporate'
  | 'preference_register' | 'missing_identity' | 'frequency_cap';

export type PolicyDecision =
  | { readonly ok: true; readonly initiative: Initiative; readonly notBefore: Date | null }
  | { readonly ok: false; readonly reason: PolicyRefusal; readonly initiative: Initiative };

export interface PolicyInput {
  readonly contactId: string;
  readonly channel: 'email' | 'sms';
  readonly purpose: Purpose;
  readonly inReplyTo?: string;
  readonly recipient: string;
  readonly body: string;
  readonly register?: PreferenceRegister;
}

export async function contactRules(tx: TenantTx): Promise<ContactRules> {
  const r = await tx.selectFrom('regions').select('contact_rules').where('code', '=', tx.scope.region).executeTakeFirstOrThrow();
  return ContactRulesSchema.parse(r.contact_rules);
}

const NEVER_DELAYED: ReadonlySet<Purpose> = new Set(['ack', 'safety']);

export async function checkSendPolicy(tx: TenantTx, clock: Clock, p: PolicyInput): Promise<PolicyDecision> {
  const initiative: Initiative = p.purpose !== 'marketing' && p.inReplyTo ? 'response' : 'proactive';
  const no = (reason: PolicyRefusal): PolicyDecision => ({ ok: false, reason, initiative });

  // 0. Only a live business messages its customers (§18, §81): not while onboarding, nor in shadow mode.
  const t = await tx.selectFrom('tenants').select('status').where('id', '=', tx.scope.tenantId).executeTakeFirstOrThrow();
  if (t.status !== 'active') return no('tenant_not_live');

  // 1. Provenance.
  const c = await tx.selectFrom('contacts').select(['source', 'lawful_basis', 'captured_at', 'captured_by', 'subscriber_type']).where('id', '=', p.contactId).executeTakeFirst();
  if (!c || !c.source.trim() || !c.lawful_basis.trim() || !c.captured_by.trim() || !c.captured_at) return no('no_provenance');
  let tier: string | null = c.source.startsWith('channel:') ? 'A' : null;
  if (!tier) {
    const s = await tx.selectFrom('lead_sources').select('tier').where('key', '=', c.source).where('enabled', '=', true).executeTakeFirst();
    tier = s?.tier ?? null;
  }
  if (!tier) return no('no_provenance');

  // 2. Tier enabled in this region.
  const rules = await contactRules(tx);
  if (!rules.tiers_enabled.includes(tier as ContactRules['tiers_enabled'][number])) return no('tier_disabled');

  // 3. Purpose limitation.
  const rule = await tx.selectFrom('purpose_rules').select('rule').where('tier', '=', tier).where('purpose', '=', p.purpose).executeTakeFirst();
  if (!rule || rule.rule === 'never') return no('purpose_not_allowed');
  const consented = async () => {
    const latest = await tx.selectFrom('consents').select('action').where('contact_id', '=', p.contactId).where('purpose', '=', 'marketing')
      .where('channel', 'in', [p.channel, 'all']).orderBy('recorded_at', 'desc').orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    return latest?.action === 'granted';
  };
  if (rule.rule === 'consent' && !(await consented())) return no('no_consent');

  // 4. Corporate-only outreach (Tier C) never reaches anyone treated as an individual.
  if (tier === 'C' && (rules.treat_as_individual.includes(c.subscriber_type) || !['company', 'public_body'].includes(c.subscriber_type))) return no('not_corporate');

  // 5. Preference registers for marketing by text (and voice, when it exists).
  if (p.purpose === 'marketing' && p.channel === 'sms' && rules.preference_registers.length) {
    // Fail closed: a listed number, or no answer from the register, means no. (Whether a prior consent
    // overrides a listing is a question for counsel; until answered, it doesn't.)
    const result = await (p.register ?? NO_REGISTER).check('sms', p.recipient);
    if (result !== 'clear') return no('preference_register');
  }

  // 6. Identity in marketing: who it's from, how to stop, how data is used.
  if (p.purpose === 'marketing' && !(/\b(unsubscribe|reply stop|opt out)\b/i.test(p.body) && /https:\/\/\S+/.test(p.body))) return no('missing_identity');

  // 7. Caps and quiet hours. Acknowledgements and safety messages are never delayed or capped.
  if (NEVER_DELAYED.has(p.purpose)) return { ok: true, initiative, notBefore: null };
  const nowMs = clock.nowMs();
  const since = (ms: number) => new Date(nowMs - ms);
  const recent = (from: Date) => tx.selectFrom('outbox').select(sql<string>`count(*)`.as('n')).where('contact_id', '=', p.contactId)
    .where('state', 'in', ['reserved', 'sending', 'sent', 'ambiguous']).where('reserved_at', '>=', from);
  if (initiative === 'response') {
    const n = Number((await recent(since(3_600_000)).where('initiative', '=', 'response').where('purpose', 'not in', ['ack', 'safety']).executeTakeFirstOrThrow()).n);
    if (n >= rules.caps.responses_per_hour) return no('frequency_cap');
    return { ok: true, initiative, notBefore: null };
  }
  const n7 = Number((await recent(since(7 * 86_400_000)).where('initiative', '=', 'proactive').executeTakeFirstOrThrow()).n);
  if (n7 >= rules.caps.proactive_per_7_days) return no('frequency_cap');
  if (p.purpose === 'marketing') {
    const n30 = Number((await recent(since(30 * 86_400_000)).where('purpose', '=', 'marketing').executeTakeFirstOrThrow()).n);
    if (n30 >= rules.caps.marketing_per_30_days) return no('frequency_cap');
  }
  return { ok: true, initiative, notBefore: nextSendingTime(nowMs, rules) };
}

/** Null if now is inside the sending window; otherwise the window's next opening (local time). */
export function nextSendingTime(nowMs: number, rules: Pick<ContactRules, 'timezone' | 'sending_window'>): Date | null {
  const tz = rules.timezone;
  const { date, time } = localParts(nowMs, tz);
  const { start, end } = rules.sending_window;
  if (time >= start && time < end) return null;
  const day = time < start ? date : addDays(date, 1);
  return new Date(localToEpoch(day, start, tz));
}
