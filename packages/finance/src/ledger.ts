/**
 * The ledger (§19.2, F15): append-only double entry, per business. Code refuses an unbalanced posting
 * before it reaches the database, and the database refuses it again at commit. Idempotent by key.
 */
import { appendAudit } from '@sevari/audit';
import { sql, type LedgerAccount, type TenantTx } from '@sevari/db';
import { ContractViolation } from '@sevari/domain';

export interface Posting {
  readonly account: LedgerAccount;
  readonly direction: 'debit' | 'credit';
  readonly amountMinor: number;
  readonly contactId?: string | null;
  readonly invoiceId?: string | null;
}
export interface PostInput {
  readonly kind: 'invoice' | 'payment' | 'fee' | 'refund' | 'credit_note' | 'payout' | 'write_off' | 'adjustment';
  readonly ref: string;
  readonly currency: string;
  readonly occurredAt: Date;
  readonly idempotencyKey: string;
  readonly lines: readonly Posting[];
}

export async function post(tx: TenantTx, p: PostInput): Promise<{ id: string; created: boolean }> {
  const lines = p.lines.filter((l) => l.amountMinor !== 0);
  if (lines.some((l) => !Number.isSafeInteger(l.amountMinor) || l.amountMinor < 0)) throw new ContractViolation('§19.2', 'ledger amounts are positive whole minor units');
  const debit = lines.filter((l) => l.direction === 'debit').reduce((a, l) => a + l.amountMinor, 0);
  const credit = lines.filter((l) => l.direction === 'credit').reduce((a, l) => a + l.amountMinor, 0);
  if (lines.length < 2 || debit !== credit) throw new ContractViolation('F15', `posting ${p.ref} does not balance (debits ${debit}, credits ${credit})`);
  const existing = await tx.selectFrom('ledger_transactions').select('id').where('idempotency_key', '=', p.idempotencyKey).executeTakeFirst();
  if (existing) return { id: existing.id, created: false };
  const t = await tx.insertInto('ledger_transactions').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, kind: p.kind, ref: p.ref, currency: p.currency, occurred_at: p.occurredAt, idempotency_key: p.idempotencyKey,
  }).onConflict((oc) => oc.columns(['tenant_id', 'idempotency_key']).doNothing()).returning('id').executeTakeFirst();
  if (!t) return { id: (await tx.selectFrom('ledger_transactions').select('id').where('idempotency_key', '=', p.idempotencyKey).executeTakeFirstOrThrow()).id, created: false };
  await tx.insertInto('ledger_entries').values(lines.map((l) => ({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, transaction_id: t.id, account: l.account, direction: l.direction, amount_minor: l.amountMinor,
    contact_id: l.contactId ?? null, invoice_id: l.invoiceId ?? null,
  }))).execute();
  await appendAudit(tx, { type: 'ledger.posted', actor: { kind: 'system' }, subject: `ledger:${t.id}`, payload: { kind: p.kind, ref: p.ref, amount_minor: debit, currency: p.currency } });
  return { id: t.id, created: true };
}

/** Balance of each account (debits positive). The whole ledger always sums to zero (F15). */
export async function trialBalance(tx: TenantTx): Promise<Record<string, number>> {
  const rows = await tx.selectFrom('ledger_entries').select(['account', sql<string>`sum(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END)`.as('bal')]).groupBy('account').execute();
  return Object.fromEntries(rows.map((r) => [r.account, Number(r.bal)]));
}
