/**
 * Brevo transactional email (ADR docs/adr/providers/email-brevo.md). Chosen by Dan on 21 October 2026.
 *
 * Calls go only through the egress client (an HTTP port is injected; the egress allowlist decides),
 * and only once the processor is approved in config/processors.yaml. What Brevo does and doesn't give us:
 *   - no idempotency key and no lookup by our reference: so a lost response is NEVER retried blindly;
 *     the outbox marks it ambiguous and a person checks (Part J §66). Residual risk is in the ADR.
 *   - our outbox id travels as a custom header and a tag, so a person (or a later lookup) can find it.
 *   - a 429 (rate or daily limit: the free plan is 300 emails a day) is "definitely not sent, try later".
 */
import type { OutboundEnvelope, OutboundProvider, SendOutcome } from './provider.ts';

export const BREVO_HOST = 'api.brevo.com';
const SEND_URL = `https://${BREVO_HOST}/v3/smtp/email`;

/** The egress client's send(), or a test double. */
export type HttpPort = (req: { url: string; method: 'POST'; headers: Record<string, string>; body: string; timeoutMs: number }) => Promise<{ status: number; body: Buffer }>;

export interface BrevoConfig {
  /** From the in-region secrets store, never from the repository (INV-10). */
  readonly apiKey: string;
  /** A sender verified in Brevo (domain authenticated with SPF and DKIM). */
  readonly sender: { readonly email: string; readonly name: string };
  readonly replyTo?: string;
  readonly timeoutMs?: number;
}

/** Brevo's error codes and messages that mean "this address must not be emailed again". */
const BLOCKED = /\b(blacklist(ed)?|blocked|unsubscribed|hard ?bounced?|spam complaint)\b/i;

export class BrevoProvider implements OutboundProvider {
  readonly name = 'brevo';
  readonly channels = ['email'] as const;
  readonly egressHosts: readonly string[] = [BREVO_HOST];
  readonly supportsIdempotencyKey: boolean = false;
  readonly supportsLookup: boolean = false;
  readonly #http: HttpPort;
  readonly #cfg: BrevoConfig;

  constructor(http: HttpPort, cfg: BrevoConfig) {
    if (!cfg.apiKey || cfg.apiKey.length < 16) throw new Error('Brevo API key missing or malformed (it comes from the secrets store)');
    this.#http = http;
    this.#cfg = cfg;
  }

  async send(env: OutboundEnvelope): Promise<SendOutcome> {
    if (env.channel !== 'email') return { status: 'rejected', reason: 'brevo is configured for email only', suppress: false };
    const body = JSON.stringify({
      sender: this.#cfg.sender,
      to: [{ email: env.to }],
      ...((env.replyTo ?? this.#cfg.replyTo) ? { replyTo: { email: env.replyTo ?? this.#cfg.replyTo } } : {}),
      subject: env.subject ?? `Your enquiry with ${this.#cfg.sender.name}`,
      textContent: env.text,
      headers: { 'X-Sevari-Ref': env.reference },
      tags: [`sevari:${env.reference}`],
    });
    // A thrown error (timeout, reset) means we can't know whether Brevo accepted it: ambiguous, by design.
    const res = await this.#http({
      url: SEND_URL, method: 'POST', timeoutMs: this.#cfg.timeoutMs ?? 10_000, body,
      headers: { 'api-key': this.#cfg.apiKey, 'content-type': 'application/json', accept: 'application/json' },
    });
    const parsed = safeJson(res.body);
    if (res.status >= 200 && res.status < 300) {
      const id = typeof parsed?.['messageId'] === 'string' ? parsed['messageId'] : null;
      if (!id) throw new Error(`brevo answered ${res.status} without a message id`);
      return { status: 'accepted', providerMessageId: id };
    }
    const message = `${String(parsed?.['code'] ?? '')} ${String(parsed?.['message'] ?? '')}`.trim().slice(0, 160);
    if (res.status === 429) return { status: 'deferred', reason: `brevo rate or daily limit reached${message ? `: ${message}` : ''}` };
    if (res.status === 401 || res.status === 403) throw new Error(`brevo refused our credentials (${res.status}); nothing was sent`);
    if (res.status >= 500) throw new Error(`brevo server error ${res.status}`);
    return { status: 'rejected', reason: `brevo ${res.status}${message ? `: ${message}` : ''}`, suppress: BLOCKED.test(message) };
  }

  async lookup(): Promise<{ providerMessageId: string } | null> {
    return null;
  }
}

function safeJson(b: Buffer): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(b.toString('utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
