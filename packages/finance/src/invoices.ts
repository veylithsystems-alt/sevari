/**
 * Invoices (§19.2). Drafted deterministically from the owner's confirmed records; issued (numbered and
 * posted to the ledger) only when the message sending it is authorised. Issued invoices never change:
 * corrections are credit notes. Numbers are gapless per business.
 */
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantTx } from '@sevari/db';
import { ContractViolation } from '@sevari/domain';
import { post } from './ledger.ts';
import { vatSplit, type VatTreatment } from './money.ts';

export interface TaxRules { readonly currency: string; readonly vat_standard_rate_bp: number; readonly payment_terms_days: number }
export async function taxRules(tx: TenantTx): Promise<TaxRules> {
  const r = await tx.selectFrom('regions').select('tax_rules').where('code', '=', tx.scope.region).executeTakeFirstOrThrow();
  return r.tax_rules as unknown as TaxRules;
}

export interface DraftLine { readonly description: string; readonly quantity: number; readonly unitMinor: number; readonly sourceRef?: string }

export async function draftInvoice(tx: TenantTx, d: {
  contactId: string; bookingId?: string | null; vatTreatment: VatTreatment; lines: readonly DraftLine[]; factsUsed: readonly string[];
}): Promise<{ id: string; net: number; vat: number; total: number; currency: string }> {
  if (!d.lines.length) throw new ContractViolation('§19.2', 'an invoice needs at least one line');
  const rules = await taxRules(tx);
  const gross = d.lines.reduce((a, l) => a + l.quantity * l.unitMinor, 0);
  const s = vatSplit(gross, d.vatTreatment, d.vatTreatment === 'not_registered' ? 0 : rules.vat_standard_rate_bp);
  const inv = await tx.insertInto('invoices').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, contact_id: d.contactId, booking_id: d.bookingId ?? null, currency: rules.currency,
    vat_treatment: d.vatTreatment, vat_rate_bp: d.vatTreatment === 'not_registered' ? 0 : rules.vat_standard_rate_bp,
    net_minor: s.net, vat_minor: s.vat, total_minor: s.total, facts_used: [...d.factsUsed],
  }).returning('id').executeTakeFirstOrThrow();
  await tx.insertInto('invoice_lines').values(d.lines.map((l, i) => ({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, invoice_id: inv.id, position: i + 1, description: l.description, quantity: l.quantity,
    unit_minor: l.unitMinor, amount_minor: l.quantity * l.unitMinor, source_ref: l.sourceRef ?? null,
  }))).execute();
  return { id: inv.id, ...s, currency: rules.currency };
}

/** Numbers and posts an invoice: DR receivables (total) / CR revenue (net) / CR VAT (vat). Idempotent. */
export async function issueInvoice(deps: { clock: Clock }, tx: TenantTx, invoiceId: string): Promise<{ number: string }> {
  const inv = await tx.selectFrom('invoices').selectAll().where('id', '=', invoiceId).forUpdate().executeTakeFirstOrThrow();
  if (inv.status !== 'draft') return { number: inv.number ?? '' };
  await tx.insertInto('invoice_counters').values({ tenant_id: tx.scope.tenantId, region: tx.scope.region }).onConflict((oc) => oc.column('tenant_id').doNothing()).execute();
  const c = await tx.selectFrom('invoice_counters').select(['next_number', 'prefix']).forUpdate().executeTakeFirstOrThrow();
  await tx.updateTable('invoice_counters').set({ next_number: c.next_number + 1 }).execute();
  const number = `${c.prefix}${String(c.next_number).padStart(5, '0')}`;
  const rules = await taxRules(tx);
  const now = deps.clock.now();
  const due = new Date(now.getTime() + rules.payment_terms_days * 86_400_000).toISOString().slice(0, 10);
  await tx.updateTable('invoices').set({ status: 'issued', number, issued_at: now, due_on: due }).where('id', '=', invoiceId).execute();
  const total = Number(inv.total_minor);
  await post(tx, {
    kind: 'invoice', ref: number, currency: inv.currency, occurredAt: now, idempotencyKey: `invoice:${invoiceId}`,
    lines: [
      { account: 'accounts_receivable', direction: 'debit', amountMinor: total, contactId: inv.contact_id, invoiceId },
      { account: 'revenue', direction: 'credit', amountMinor: Number(inv.net_minor), invoiceId },
      { account: 'vat_output', direction: 'credit', amountMinor: Number(inv.vat_minor), invoiceId },
    ],
  });
  await appendAudit(tx, { type: 'invoice.issued', actor: { kind: 'system' }, subject: `invoice:${invoiceId}`, payload: { number, total_minor: total, currency: inv.currency } });
  return { number };
}

/** A draft that won't be sent is voided (it never had a number, so the sequence stays gapless). */
export async function voidDraftInvoice(tx: TenantTx, invoiceId: string): Promise<void> {
  await tx.updateTable('invoices').set({ status: 'void' }).where('id', '=', invoiceId).where('status', '=', 'draft').execute();
  await tx.updateTable('payment_links').set({ status: 'cancelled' }).where('invoice_id', '=', invoiceId).where('status', '=', 'open').execute();
}

/** Remaining to pay on an invoice. */
export const outstanding = (inv: { total_minor: string | number; paid_minor: string | number }) => Number(inv.total_minor) - Number(inv.paid_minor);
