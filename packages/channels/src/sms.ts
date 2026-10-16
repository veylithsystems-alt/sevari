import { createHmac, timingSafeEqual } from 'node:crypto';
import { cleanText, InboundParseError, type ChannelAdapter, type RawInbound, type VerifyContext, type VerifyResult } from './adapter.ts';

/**
 * SMS channel over a provider port. Contract §57: no Twilio code before Dan approves the ADR, so v1
 * ships only the FakeSmsProvider, which models the real constraints (provider signature over URL +
 * body, provider message id, no media) against recorded fixtures.
 */
export interface SmsProvider {
  readonly name: string;
  readonly egressHosts: readonly string[];
  verify(raw: RawInbound, secret: Buffer): boolean;
  parse(raw: RawInbound): { messageId: string; from: string; text: string; hasMedia: boolean };
}

export const FakeSmsProvider: SmsProvider = {
  name: 'fake',
  egressHosts: [],
  verify(raw, secret) {
    const presented = raw.headers['x-fake-signature'] ?? '';
    const expected = createHmac('sha256', secret).update(raw.url).update(raw.body).digest('base64');
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  },
  parse(raw) {
    const p = new URLSearchParams(raw.body.toString('utf8'));
    const messageId = p.get('MessageSid') ?? '';
    const from = p.get('From') ?? '';
    if (!/^[A-Za-z0-9]{8,64}$/.test(messageId)) throw new InboundParseError('missing or malformed MessageSid');
    if (!from) throw new InboundParseError('missing From');
    const hasMedia = Number(p.get('NumMedia') ?? '0') > 0 || [...p.keys()].some((k) => /^MediaUrl|Recording/i.test(k));
    return { messageId, from, text: p.get('Body') ?? '', hasMedia };
  },
};

export function smsAdapter(provider: SmsProvider): ChannelAdapter {
  return {
    channel: 'sms',
    capabilities: { inbound: true, outbound: true, maxBodyBytes: 16 * 1024 },
    consentModel: 'reply_to_own_contact',
    egressHosts: provider.egressHosts,
    verify(raw: RawInbound, ctx: VerifyContext): VerifyResult {
      if (!ctx.secret) return { ok: false, status: 401, reason: 'endpoint has no provider secret' };
      if (!provider.verify(raw, ctx.secret)) return { ok: false, status: 401, reason: 'bad provider signature' };
      return { ok: true };
    },
    parse(raw: RawInbound) {
      const m = provider.parse(raw);
      // §50.1 / F40 spirit: Sevari never accepts media or recordings over SMS in v1.
      if (m.hasMedia) throw new InboundParseError('media and recordings are not accepted');
      const text = cleanText(m.text, 2_000);
      if (!text) throw new InboundParseError('empty message');
      return { providerMessageId: `sms:${provider.name}:${m.messageId}`, kind: 'enquiry', from: { phone: m.from }, text };
    },
  };
}
