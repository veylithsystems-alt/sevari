/**
 * MoneyPort (§19.1). The money-flow decision isn't made, so it is a port with two modes:
 *   Mode 1, direct (default): the customer pays the business's own processor account. Sevari makes payment
 *     links and records events; it never holds, pools or moves funds.
 *   Mode 2, platform: exists behind the interface, LOCKED. Its operations (payouts, transfers, balance moves)
 *     throw unless the business's money mode is 'platform_signed_off', which only the owner role can set,
 *     with counsel's recorded sign-off (F14).
 */
import type { TenantTx } from '@sevari/db';
import { ContractViolation } from '@sevari/domain';

/** The business's own payment processor account (Stripe, GoCardless, ...), through the egress client. */
export interface PaymentProcessor {
  readonly name: string;
  readonly egressHosts: readonly string[];
  createPaymentLink(input: { reference: string; amountMinor: number; currency: string; description: string }): Promise<{ providerLinkId: string; url: string }>;
  refund(input: { providerPaymentId: string; amountMinor: number; reference: string }): Promise<{ providerRefundId: string }>;
}

/** Operations that move money between parties. Only Mode 2, only after sign-off. */
export interface PlatformMoneyOps {
  createPayout(input: { amountMinor: number; currency: string; reference: string }): Promise<{ id: string }>;
  createTransfer(input: { amountMinor: number; currency: string; destination: string; reference: string }): Promise<{ id: string }>;
  adjustBalance(input: { amountMinor: number; currency: string; reason: string }): Promise<{ id: string }>;
}

export interface MoneyPort {
  readonly mode: 'direct' | 'platform_signed_off';
  createPaymentLink(input: { reference: string; amountMinor: number; currency: string; description: string }): Promise<{ providerLinkId: string; url: string; provider: string }>;
  refund(input: { providerPaymentId: string; amountMinor: number; reference: string }): Promise<{ providerRefundId: string }>;
  /** Mode 2 only. Throws in every other mode, before anything reaches a processor (F14). */
  platform(): PlatformMoneyOps;
}

const locked = (op: string): never => { throw new ContractViolation('F14', `${op}: Sevari never moves money between parties unless the money mode is platform_signed_off (§19.1)`); };

/** The money port for one business, chosen by its recorded money mode. */
export async function moneyPortFor(tx: TenantTx, processor: PaymentProcessor, platformOps?: PlatformMoneyOps): Promise<MoneyPort> {
  const t = await tx.selectFrom('tenants').select(['money_mode', 'money_mode_signoff']).where('id', '=', tx.scope.tenantId).executeTakeFirstOrThrow();
  const signedOff = t.money_mode === 'platform_signed_off' && t.money_mode_signoff !== null;
  return {
    mode: signedOff ? 'platform_signed_off' : 'direct',
    createPaymentLink: async (i) => ({ ...(await processor.createPaymentLink(i)), provider: processor.name }),
    refund: (i) => processor.refund(i),
    platform: () => {
      if (!signedOff || !platformOps) return { createPayout: async () => locked('payout'), createTransfer: async () => locked('transfer'), adjustBalance: async () => locked('balance operation') };
      return platformOps;
    },
  };
}

/** Deterministic processor for tests and development. Records every call so tests can prove what never happened. */
export class FakePaymentProcessor implements PaymentProcessor {
  readonly name = 'fakepay';
  readonly egressHosts: readonly string[] = [];
  readonly calls: { op: string; input: unknown }[] = [];
  #n = 0;
  async createPaymentLink(input: { reference: string; amountMinor: number; currency: string; description: string }) {
    this.calls.push({ op: 'link', input });
    this.#n++;
    return { providerLinkId: `plink_${this.#n}`, url: `https://pay.fakepay.example/l/${this.#n}` };
  }
  async refund(input: { providerPaymentId: string; amountMinor: number; reference: string }) {
    this.calls.push({ op: 'refund', input });
    return { providerRefundId: `re_${++this.#n}` };
  }
}
