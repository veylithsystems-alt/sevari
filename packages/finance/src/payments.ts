/**
 * Payment events from the business's own processor (§19.2, F16): verified upstream, recorded once however
 * many times they arrive, and posted to the ledger:
 *   payment   DR processor clearing / CR receivables (any excess → customer credit)
 *   fee       DR processor fees / CR processor clearing
 *   refund    DR refunds / CR processor clearing
 *   payout    DR bank / CR processor clearing
 */
import { appendAudit } from '@sevari/audit';
import type { TenantTx } from '@sevari/db';
import { post } from './ledger.ts';
import { outstanding } from './invoices.ts';

export interface PaymentEvent {
  readonly provider: string;
  readonly providerEventId: string;
  readonly kind: 'payment_succeeded' | 'payment_failed' | 'refund_succeeded' | 'fee' | 'payout';
  readonly invoiceId?: string | null;
  readonly providerPaymentId?: string | null;
  readonly amountMinor: number;
  readonly feeMinor?: number;
  readonly currency: string;
  readonly occurredAt: Date;
}

export async function recordPaymentEvent(tx: TenantTx, e: PaymentEvent): Promise<{ status: 'recorded' | 'duplicate'; id: string }> {
  const row = await tx.insertInto('payment_events').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, provider: e.provider, provider_event_id: e.providerEventId, kind: e.kind,
    invoice_id: e.invoiceId ?? null, provider_payment_id: e.providerPaymentId ?? null, amount_minor: e.amountMinor, fee_minor: e.feeMinor ?? 0, currency: e.currency, occurred_at: e.occurredAt,
  }).onConflict((oc) => oc.columns(['tenant_id', 'provider', 'provider_event_id']).doNothing()).returning('id').executeTakeFirst();
  if (!row) {
    const prior = await tx.selectFrom('payment_events').select('id').where('provider', '=', e.provider).where('provider_event_id', '=', e.providerEventId).executeTakeFirstOrThrow();
    return { status: 'duplicate', id: prior.id };
  }
  const key = (s: string) => `pe:${row.id}:${s}`;
  const base = { currency: e.currency, occurredAt: e.occurredAt };
  if (e.kind === 'payment_succeeded' && e.amountMinor > 0) {
    let toInvoice = 0;
    let contactId: string | null = null;
    if (e.invoiceId) {
      const inv = await tx.selectFrom('invoices').select(['id', 'total_minor', 'paid_minor', 'contact_id', 'status']).where('id', '=', e.invoiceId).forUpdate().executeTakeFirst();
      if (inv && (inv.status === 'issued' || inv.status === 'part_paid')) {
        toInvoice = Math.min(e.amountMinor, outstanding(inv));
        contactId = inv.contact_id;
        const paid = Number(inv.paid_minor) + toInvoice;
        await tx.updateTable('invoices').set({ paid_minor: paid, status: paid >= Number(inv.total_minor) ? 'paid' : 'part_paid' }).where('id', '=', inv.id).execute();
        if (paid >= Number(inv.total_minor)) await tx.updateTable('payment_links').set({ status: 'paid' }).where('invoice_id', '=', inv.id).where('status', '=', 'open').execute();
      }
    }
    const excess = e.amountMinor - toInvoice;
    const t = await post(tx, {
      kind: 'payment', ref: e.providerEventId, ...base, idempotencyKey: key('payment'),
      lines: [
        { account: 'processor_clearing', direction: 'debit', amountMinor: e.amountMinor },
        { account: 'accounts_receivable', direction: 'credit', amountMinor: toInvoice, contactId, invoiceId: e.invoiceId ?? null },
        { account: 'customer_credit', direction: 'credit', amountMinor: excess, contactId },
      ],
    });
    await tx.updateTable('payment_events').set({ ledger_transaction_id: t.id }).where('id', '=', row.id).execute();
    if (e.feeMinor) await post(tx, { kind: 'fee', ref: e.providerEventId, ...base, idempotencyKey: key('fee'), lines: [{ account: 'processor_fees', direction: 'debit', amountMinor: e.feeMinor }, { account: 'processor_clearing', direction: 'credit', amountMinor: e.feeMinor }] });
  } else if (e.kind === 'fee' && e.amountMinor > 0) {
    await post(tx, { kind: 'fee', ref: e.providerEventId, ...base, idempotencyKey: key('fee'), lines: [{ account: 'processor_fees', direction: 'debit', amountMinor: e.amountMinor }, { account: 'processor_clearing', direction: 'credit', amountMinor: e.amountMinor }] });
  } else if (e.kind === 'refund_succeeded' && e.amountMinor > 0) {
    await post(tx, { kind: 'refund', ref: e.providerEventId, ...base, idempotencyKey: key('refund'), lines: [{ account: 'refunds', direction: 'debit', amountMinor: e.amountMinor, invoiceId: e.invoiceId ?? null }, { account: 'processor_clearing', direction: 'credit', amountMinor: e.amountMinor }] });
  } else if (e.kind === 'payout' && e.amountMinor > 0) {
    await post(tx, { kind: 'payout', ref: e.providerEventId, ...base, idempotencyKey: key('payout'), lines: [{ account: 'bank', direction: 'debit', amountMinor: e.amountMinor }, { account: 'processor_clearing', direction: 'credit', amountMinor: e.amountMinor }] });
  }
  await appendAudit(tx, { type: 'payment.event', actor: { kind: 'provider', ref: e.provider }, subject: `payment_event:${row.id}`, payload: { kind: e.kind, amount_minor: e.amountMinor, currency: e.currency, ...(e.invoiceId ? { invoice: `invoice:${e.invoiceId}` } : {}) } });
  return { status: 'recorded', id: row.id };
}
