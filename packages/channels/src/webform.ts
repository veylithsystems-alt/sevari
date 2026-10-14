import { z } from 'zod';
import { cleanText, InboundParseError, type ChannelAdapter, type RawInbound, type VerifyContext, type VerifyResult } from './adapter.ts';

const Body = z.object({
  submission_id: z.string().uuid(),
  name: z.string().max(200).optional(),
  email: z.string().email().max(320).optional(),
  phone: z.string().max(40).optional(),
  subject: z.string().max(300).optional(),
  message: z.string().min(1).max(10_000),
  /** Honeypot: hidden from people; bots fill it. */
  company_website: z.string().max(500).optional(),
}).strict();

/**
 * The tenant's website enquiry form. Public by nature, so: exact Origin allowlist, a honeypot,
 * per-endpoint rate limits (API layer) and a client-generated submission id for idempotency.
 */
export const webformAdapter: ChannelAdapter = {
  channel: 'webform',
  capabilities: { inbound: true, outbound: false, maxBodyBytes: 32 * 1024 },
  consentModel: 'reply_to_own_contact',
  egressHosts: [],
  verify(raw: RawInbound, ctx: VerifyContext): VerifyResult {
    const origin = raw.headers['origin'];
    if (!origin || !ctx.allowedOrigins.includes(origin)) return { ok: false, status: 403, reason: 'origin not allowed for this form' };
    try {
      const b = JSON.parse(raw.body.toString('utf8')) as { company_website?: unknown };
      if (typeof b.company_website === 'string' && b.company_website.trim() !== '') return { ok: true, drop: 'honeypot' };
    } catch {
      return { ok: false, status: 400, reason: 'body is not JSON' };
    }
    return { ok: true };
  },
  parse(raw: RawInbound) {
    const r = Body.safeParse(JSON.parse(raw.body.toString('utf8')));
    if (!r.success) throw new InboundParseError(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const b = r.data;
    if (!b.email && !b.phone) throw new InboundParseError('an email address or a phone number is required');
    return {
      providerMessageId: `webform:${b.submission_id}`, kind: 'enquiry',
      from: { ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), ...(b.name ? { name: cleanText(b.name, 200) } : {}) },
      ...(b.subject ? { subject: cleanText(b.subject, 300) } : {}),
      text: cleanText(b.message, 10_000),
    };
  },
};
