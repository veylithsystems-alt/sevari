import { z } from 'zod';
import { cleanText, InboundParseError, type ChannelAdapter, type RawInbound, type VerifyContext, type VerifyResult } from './adapter.ts';
import { SIGNATURE_TOLERANCE_SECONDS, verifySignature } from './signing.ts';

const Body = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(['enquiry', 'task']).optional(),
  from: z.object({ email: z.string().email().max(320).optional(), phone: z.string().max(40).optional(), name: z.string().max(200).optional() }),
  subject: z.string().max(500).optional(),
  text: z.string().min(1).max(50_000),
}).strict();

/**
 * Signed JSON webhook: used by the API channel (tenant systems, tasks) and by an inbound-email relay
 * until an email provider ADR is approved. Replay defence: timestamp tolerance + provider id uniqueness.
 */
export function signedWebhookAdapter(channel: 'email' | 'api'): ChannelAdapter {
  return {
    channel,
    capabilities: { inbound: true, outbound: false, maxBodyBytes: 256 * 1024 },
    consentModel: 'reply_to_own_contact',
    egressHosts: [],
    verify(raw: RawInbound, ctx: VerifyContext): VerifyResult {
      if (!ctx.secret) return { ok: false, status: 401, reason: 'endpoint has no signing secret' };
      const ts = Number(raw.headers['x-sevari-timestamp']);
      const sig = raw.headers['x-sevari-signature'];
      if (!Number.isInteger(ts) || !sig) return { ok: false, status: 401, reason: 'missing signature headers' };
      if (Math.abs(ctx.nowMs / 1000 - ts) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, status: 401, reason: 'stale or future timestamp' };
      if (!verifySignature(ctx.secret, ts, raw.body, sig)) return { ok: false, status: 401, reason: 'bad signature' };
      return { ok: true };
    },
    parse(raw: RawInbound) {
      let json: unknown;
      try {
        json = JSON.parse(raw.body.toString('utf8'));
      } catch {
        throw new InboundParseError('body is not JSON');
      }
      const r = Body.safeParse(json);
      if (!r.success) throw new InboundParseError(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const b = r.data;
      if (!b.from.email && !b.from.phone) throw new InboundParseError('from.email or from.phone is required');
      // Only the tenant's own API may submit tasks (Part K); an email is always an enquiry.
      const kind = channel === 'api' ? (b.kind ?? 'enquiry') : 'enquiry';
      return {
        providerMessageId: `${channel}:${b.id}`, kind,
        from: { ...(b.from.email ? { email: b.from.email } : {}), ...(b.from.phone ? { phone: b.from.phone } : {}), ...(b.from.name ? { name: cleanText(b.from.name, 200) } : {}) },
        ...(b.subject ? { subject: cleanText(b.subject, 500) } : {}),
        text: cleanText(b.text, 50_000),
      };
    },
  };
}
