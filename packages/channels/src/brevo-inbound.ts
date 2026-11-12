/**
 * Email received through Brevo's inbound parsing (Brevo is an approved processor; ADR email-brevo).
 * Brevo receives mail for the cell's receiving domain and posts it, in batches, to one cell URL with a
 * secret bearer token we chose when creating the webhook. Each email is then handed to intake on its own,
 * for the business whose receiving address it was sent to.
 *
 * Never answered: automatic replies ("out of office", bounces, mailing lists), no-reply senders, and spam,
 * so two machines can never end up mailing each other forever.
 */
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { cleanText, InboundParseError, type ChannelAdapter, type RawInbound, type VerifyContext, type VerifyResult } from './adapter.ts';

const Mailbox = z.object({ Address: z.string().max(320), Name: z.string().max(200).nullish() }).passthrough();
export const BrevoInboundItem = z.object({
  MessageId: z.string().min(1).max(998),
  InReplyTo: z.string().max(998).nullish(),
  From: Mailbox,
  To: z.array(Mailbox).default([]),
  Recipients: z.array(Mailbox).default([]),
  ReplyTo: Mailbox.nullish(),
  Subject: z.string().max(998).nullish(),
  RawTextBody: z.string().nullish(),
  ExtractedMarkdownMessage: z.string().nullish(),
  Spam: z.object({ Score: z.number() }).partial().nullish(),
  Headers: z.union([z.record(z.string(), z.union([z.string(), z.array(z.string())])), z.array(z.unknown())]).nullish(),
}).passthrough();
export type BrevoInboundItem = z.infer<typeof BrevoInboundItem>;
export const BrevoInboundBatch = z.object({ items: z.array(z.unknown()).max(100) }).passthrough();

/** rspamd scores at or above this are treated as spam and never answered. */
export const SPAM_SCORE_LIMIT = 10;

function header(item: BrevoInboundItem, name: string): string | undefined {
  const h = item.Headers;
  if (!h || Array.isArray(h)) return undefined;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  const v = key ? h[key] : undefined;
  return Array.isArray(v) ? v.join(', ') : v;
}

/** Why this email must not be answered, or null. */
export function dropReason(item: BrevoInboundItem): string | null {
  const auto = header(item, 'auto-submitted');
  if (auto && auto.trim().toLowerCase() !== 'no') return 'auto_reply';
  if (/^(bulk|junk|list|auto_reply)$/i.test(header(item, 'precedence')?.trim() ?? '')) return 'auto_reply';
  if (header(item, 'x-autoreply') || header(item, 'x-autorespond') || header(item, 'list-id') || header(item, 'list-unsubscribe')) return 'auto_reply';
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)@/i.test(item.From.Address)) return 'auto_reply';
  if ((item.Spam?.Score ?? 0) >= SPAM_SCORE_LIMIT) return 'spam';
  return null;
}

/** The addresses an email was delivered to, lower-cased, for routing to a business. */
export function deliveredTo(item: BrevoInboundItem): string[] {
  return [...new Set([...item.Recipients, ...item.To].map((m) => m.Address.trim().toLowerCase()))];
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** True when the request carries the bearer token Brevo was given for this cell. */
export function isFromBrevo(headers: RawInbound['headers'], token: string): boolean {
  const m = /^Bearer (.+)$/.exec(headers['authorization'] ?? '');
  return Boolean(token && token.length >= 32 && m?.[1] && sameSecret(m[1], token));
}

/**
 * The email channel adapter. A request carrying Brevo's bearer token is one email from Brevo; anything
 * else is the signed-webhook path (the business's own system posting an email to us).
 */
export function emailAdapter(signed: ChannelAdapter, brevoToken?: string): ChannelAdapter {
  const fromBrevo = (raw: RawInbound) => Boolean(brevoToken) && (raw.headers['authorization'] ?? '').startsWith('Bearer ');
  const item = (raw: RawInbound): BrevoInboundItem => {
    let json: unknown;
    try { json = JSON.parse(raw.body.toString('utf8')); } catch { throw new InboundParseError('body is not JSON'); }
    const r = BrevoInboundItem.safeParse(json);
    if (!r.success) throw new InboundParseError(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return r.data;
  };
  return {
    ...signed,
    verify(raw: RawInbound, ctx: VerifyContext): VerifyResult {
      if (!fromBrevo(raw)) return signed.verify(raw, ctx);
      if (!isFromBrevo(raw.headers, brevoToken ?? '')) return { ok: false, status: 401, reason: 'not from Brevo' };
      try {
        const why = dropReason(item(raw));
        return why ? { ok: true, drop: why } : { ok: true };
      } catch {
        return { ok: false, status: 400, reason: 'not a Brevo inbound email' };
      }
    },
    parse(raw: RawInbound) {
      if (!fromBrevo(raw)) return signed.parse(raw);
      const e = item(raw);
      const reply = e.ReplyTo?.Address ?? e.From.Address;
      const text = (e.ExtractedMarkdownMessage?.trim() || e.RawTextBody?.trim() || '').slice(0, 20_000);
      if (!text) throw new InboundParseError('the email has no text');
      const name = e.ReplyTo?.Name ?? e.From.Name;
      return {
        providerMessageId: `brevo:${e.MessageId}`, kind: 'enquiry' as const,
        from: { email: reply, ...(name ? { name: cleanText(name, 200) } : {}) },
        ...(e.Subject ? { subject: cleanText(e.Subject, 300) } : {}),
        text: cleanText(text, 10_000),
      };
    },
  };
}
