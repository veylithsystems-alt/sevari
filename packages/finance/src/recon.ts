/**
 * Reconciliation (§19.3). Lines from processor reports and bank feeds come in once each (F16) and are
 * matched in layers, deterministically; the model never matches money:
 *   1. exact reference: the line's reference contains an open invoice's number          → 1.00
 *   2. amount + date + payer: one open invoice for exactly this amount, recent, payer    → 0.95
 *   3. amount + date: one open invoice for exactly this amount, recent                   → 0.80
 *   4. fuzzy: one open invoice within 2% of the amount                                    → 0.50
 *   otherwise: unmatched, for a person.
 * Only layers 1 and 2, at full amount, are applied automatically (F17, also a database CHECK). Everything
 * else is stored as a suggestion with its rule, confidence and evidence, and waits for the owner.
 */
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { sql, type TenantTx } from '@sevari/db';
import { normaliseForMatch } from '@sevari/domain';
import { post } from './ledger.ts';
import { outstanding } from './invoices.ts';

export const AUTO_APPLY_THRESHOLD = 0.95;

export interface StatementLine {
  readonly source: 'processor' | 'bank';
  readonly externalId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly bookedOn: string;
  readonly reference?: string;
  readonly payerHint?: string;
}

/** Each line once, however many times the feed sends it (F16). */
export async function importLines(tx: TenantTx, lines: readonly StatementLine[]): Promise<{ added: number; duplicates: number }> {
  let added = 0;
  for (const l of lines) {
    const r = await tx.insertInto('recon_lines').values({
      tenant_id: tx.scope.tenantId, region: tx.scope.region, source: l.source, external_id: l.externalId, amount_minor: l.amountMinor, currency: l.currency,
      booked_on: l.bookedOn, reference: l.reference ?? null, payer_hint: l.payerHint ?? null,
    }).onConflict((oc) => oc.columns(['tenant_id', 'source', 'external_id']).doNothing()).returning('id').executeTakeFirst();
    if (r) added++;
  }
  return { added, duplicates: lines.length - added };
}

type Rule = 'exact_reference' | 'amount_date_payer' | 'amount_date' | 'fuzzy';
interface Candidate { invoiceId: string; rule: Rule; confidence: number; remaining: number }

/** Matches every unmatched bank line. Processor lines (payouts) are checked against the processor's own events. */
export async function reconcile(deps: { keyring: TenantKeyring; clock: Clock }, tx: TenantTx): Promise<{ autoApplied: number; suggested: number; unmatched: number }> {
  const lines = await tx.selectFrom('recon_lines').selectAll().select(sql<string>`booked_on::text`.as('booked'))
    .where('status', '=', 'unmatched').where('source', '=', 'bank').orderBy('booked_on').forUpdate().execute();
  const counts = { autoApplied: 0, suggested: 0, unmatched: 0 };
  for (const line of lines) {
    const amount = Number(line.amount_minor);
    const open = await tx.selectFrom('invoices').select(['id', 'number', 'total_minor', 'paid_minor', 'issued_at', 'contact_id', 'currency'])
      .where('status', 'in', ['issued', 'part_paid']).where('kind', '=', 'invoice').where('currency', '=', line.currency).execute();
    const ref = normaliseForMatch(line.reference ?? '');
    const within = (iso: Date | null, days: number) => iso !== null && Math.abs(Date.parse(line.booked) - iso.getTime()) <= days * 86_400_000;
    let best: Candidate | null = null;
    const only = <T>(xs: readonly T[]): T | undefined => (xs.length === 1 ? xs[0] : undefined);
    const byRef = only(open.filter((i) => i.number && ref.includes(normaliseForMatch(i.number))));
    if (byRef) best = { invoiceId: byRef.id, rule: 'exact_reference', confidence: 1, remaining: outstanding(byRef) };
    if (!best) {
      const inv = only(open.filter((i) => outstanding(i) === amount && within(i.issued_at, 60)));
      if (inv) {
        const payerOk = await payerMatches(deps, tx, inv.contact_id, line.payer_hint);
        best = { invoiceId: inv.id, rule: payerOk ? 'amount_date_payer' : 'amount_date', confidence: payerOk ? 0.95 : 0.8, remaining: outstanding(inv) };
      }
    }
    if (!best) {
      const near = only(open.filter((i) => Math.abs(outstanding(i) - amount) <= Math.max(1, Math.round(outstanding(i) * 0.02))));
      if (near) best = { invoiceId: near.id, rule: 'fuzzy', confidence: 0.5, remaining: outstanding(near) };
    }
    if (!best) {
      await tx.insertInto('recon_matches').values({ tenant_id: tx.scope.tenantId, region: tx.scope.region, line_id: line.id, invoice_id: null, rule: 'fuzzy', confidence: 0, outcome: 'unmatched', evidence: JSON.stringify({ open_invoices: open.length }), status: 'suggested' }).execute();
      counts.unmatched++;
      continue;
    }
    const outcome = amount === best.remaining ? 'matched' : amount < best.remaining ? 'partial' : 'overpayment';
    const auto = best.confidence >= AUTO_APPLY_THRESHOLD && outcome === 'matched';
    await tx.insertInto('recon_matches').values({
      tenant_id: tx.scope.tenantId, region: tx.scope.region, line_id: line.id, invoice_id: best.invoiceId, rule: best.rule, confidence: best.confidence, outcome,
      evidence: JSON.stringify({ line_amount: amount, invoice_outstanding: best.remaining, reference: line.reference ? 'present' : 'absent' }), status: auto ? 'auto_applied' : 'suggested',
      ...(auto ? { decided_by: `rule:${best.rule}` } : {}),
    }).execute();
    if (auto) {
      await applyBankPayment(deps, tx, line.id, best.invoiceId, amount, line.currency, line.booked);
      counts.autoApplied++;
    } else {
      await tx.updateTable('recon_lines').set({ status: 'suggested' }).where('id', '=', line.id).execute();
      counts.suggested++;
    }
  }
  await appendAudit(tx, { type: 'recon.run', actor: { kind: 'system' }, subject: `tenant:${tx.scope.tenantId}`, payload: counts });
  return counts;
}

/** A bank payment applied to an invoice: DR bank / CR receivables. Used by auto-match and by an owner's confirmation. */
export async function applyBankPayment(deps: { clock: Clock }, tx: TenantTx, lineId: string, invoiceId: string, amountMinor: number, currency: string, bookedOn: string): Promise<void> {
  const inv = await tx.selectFrom('invoices').select(['total_minor', 'paid_minor', 'contact_id']).where('id', '=', invoiceId).forUpdate().executeTakeFirstOrThrow();
  const toInvoice = Math.min(amountMinor, outstanding(inv));
  const paid = Number(inv.paid_minor) + toInvoice;
  await tx.updateTable('invoices').set({ paid_minor: paid, status: paid >= Number(inv.total_minor) ? 'paid' : 'part_paid' }).where('id', '=', invoiceId).execute();
  await post(tx, {
    kind: 'payment', ref: `bank:${lineId}`, currency, occurredAt: new Date(`${bookedOn}T12:00:00Z`), idempotencyKey: `recon:${lineId}`,
    lines: [
      { account: 'bank', direction: 'debit', amountMinor },
      { account: 'accounts_receivable', direction: 'credit', amountMinor: toInvoice, contactId: inv.contact_id, invoiceId },
      { account: 'customer_credit', direction: 'credit', amountMinor: amountMinor - toInvoice, contactId: inv.contact_id },
    ],
  });
  await tx.updateTable('recon_lines').set({ status: 'matched' }).where('id', '=', lineId).execute();
  void deps;
}

async function payerMatches(deps: { keyring: TenantKeyring }, tx: TenantTx, contactId: string | null, hint: string | null): Promise<boolean> {
  if (!contactId || !hint) return false;
  const c = await tx.selectFrom('contacts').select(['display_name_enc']).where('id', '=', contactId).executeTakeFirst();
  if (!c?.display_name_enc) return false;
  const name = normaliseForMatch(await deps.keyring.openText(tx, { table: 'contacts', column: 'display_name_enc', rowId: contactId }, c.display_name_enc));
  const h = normaliseForMatch(hint);
  const surname = name.split(' ').filter((w) => w.length > 2).at(-1);
  return Boolean(surname && h.includes(surname));
}

/**
 * Processor totals vs the ledger (F18): what the processor says it collected, charged and paid out must equal
 * what the ledger's processor clearing account recorded, for the same events.
 */
export async function processorTotals(tx: TenantTx): Promise<{ processor: { collected: number; fees: number; refunds: number; paidOut: number; balance: number }; ledgerClearing: number }> {
  const sum = async (kind: string, col: 'amount_minor' | 'fee_minor' = 'amount_minor') =>
    Number((await tx.selectFrom('payment_events').select(sql<string>`COALESCE(sum(${sql.ref(col)}), 0)`.as('s')).where('kind', '=', kind as never).executeTakeFirstOrThrow()).s);
  const collected = await sum('payment_succeeded');
  const fees = (await sum('payment_succeeded', 'fee_minor')) + (await sum('fee'));
  const refunds = await sum('refund_succeeded');
  const paidOut = await sum('payout');
  const clearing = Number((await tx.selectFrom('ledger_entries').select(sql<string>`COALESCE(sum(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END), 0)`.as('s')).where('account', '=', 'processor_clearing').executeTakeFirstOrThrow()).s);
  return { processor: { collected, fees, refunds, paidOut, balance: collected - fees - refunds - paidOut }, ledgerClearing: clearing };
}
