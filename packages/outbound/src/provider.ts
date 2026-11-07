/**
 * Outbound provider port. Real providers (email, SMS) arrive only with an approved ADR and an allowlist
 * entry (§29). Every provider must say whether it supports idempotency keys and lookup by our reference;
 * where it supports neither, its ADR documents the residual duplicate risk (Part J §66).
 */
export interface OutboundEnvelope {
  /** Our outbox id: used as the provider idempotency key and lookup reference. */
  readonly reference: string;
  readonly channel: 'email' | 'sms';
  readonly to: string;
  readonly subject?: string;
  readonly text: string;
}

export type SendOutcome =
  | { readonly status: 'accepted'; readonly providerMessageId: string }
  | { readonly status: 'rejected'; readonly reason: string; readonly suppress: boolean }
  /** Definitely not accepted and safe to try again later (e.g. a rate or daily limit). */
  | { readonly status: 'deferred'; readonly reason: string };

export interface OutboundProvider {
  readonly name: string;
  readonly channels: readonly ('email' | 'sms')[];
  readonly egressHosts: readonly string[];
  readonly supportsIdempotencyKey: boolean;
  readonly supportsLookup: boolean;
  send(env: OutboundEnvelope): Promise<SendOutcome>;
  lookup(reference: string): Promise<{ providerMessageId: string } | null>;
}

/**
 * Deterministic fake for tests and development. Behaves like a well-behaved provider: idempotent on the
 * reference and supports lookup. Failure injection models the cases §66 requires us to survive.
 */
export class FakeProvider implements OutboundProvider {
  readonly name = 'fake';
  readonly channels = ['email', 'sms'] as const;
  readonly egressHosts: readonly string[] = [];
  readonly supportsIdempotencyKey: boolean = true;
  readonly supportsLookup: boolean = true;
  readonly accepted = new Map<string, { providerMessageId: string; env: OutboundEnvelope; at: number }>();
  /** Number of provider-side deliveries (a non-idempotent provider would deliver twice). */
  deliveries = 0;
  latencyMs = 0;
  /** Next sends: 'accept' | 'reject' | 'timeout_after_accept' | 'timeout_before_accept' | 'block'. */
  readonly script: Array<'accept' | 'reject' | 'timeout_after_accept' | 'timeout_before_accept' | 'block'> = [];
  #seq = 0;

  async send(env: OutboundEnvelope): Promise<SendOutcome> {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const step = this.script.shift() ?? 'accept';
    if (step === 'timeout_before_accept') throw new Error('provider timeout (request never arrived)');
    if (step === 'reject') return { status: 'rejected', reason: 'invalid recipient', suppress: false };
    if (step === 'block') return { status: 'rejected', reason: 'recipient opted out at provider', suppress: true };
    const existing = this.accepted.get(env.reference);
    if (!existing) {
      this.#seq += 1;
      this.accepted.set(env.reference, { providerMessageId: `FAKE${String(this.#seq).padStart(8, '0')}`, env, at: this.#seq });
      this.deliveries += 1;
    }
    if (step === 'timeout_after_accept') throw new Error('provider timeout (request accepted, response lost)');
    const done = this.accepted.get(env.reference);
    if (!done) throw new Error('fake provider lost its own record');
    return { status: 'accepted', providerMessageId: done.providerMessageId };
  }

  async lookup(reference: string): Promise<{ providerMessageId: string } | null> {
    const hit = this.accepted.get(reference);
    return hit ? { providerMessageId: hit.providerMessageId } : null;
  }
}
