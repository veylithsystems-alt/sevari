/**
 * Accounting sync (§19.5). Each business connects its own accounting software (Xero, QuickBooks, FreeAgent:
 * each needs an ADR before use). Sync is one-way by default, Sevari → their books: issued invoices and
 * payments, each pushed once (idempotent, logged for the owner). Tokens are sealed with a key of their own
 * and shredded when the business disconnects. A failed push becomes a task for the owner, never a retry loop.
 */
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { sql, withTenant, type Db, type TenantTx } from '@sevari/db';
import type { TenantScope } from '@sevari/domain';

export interface AccountingInvoice { readonly number: string; readonly issuedOn: string; readonly dueOn: string | null; readonly currency: string; readonly netMinor: number; readonly vatMinor: number; readonly totalMinor: number; readonly lines: readonly { description: string; quantity: number; unitMinor: number }[] }
export interface AccountingPayment { readonly invoiceNumber: string; readonly amountMinor: number; readonly currency: string; readonly paidOn: string; readonly reference: string }

export interface AccountingPort {
  readonly name: string;
  readonly egressHosts: readonly string[];
  /** Must be idempotent on `key` at the provider where it supports it; Sevari also never pushes a key twice. */
  pushInvoice(token: string, key: string, invoice: AccountingInvoice, mapping: Readonly<Record<string, string>>): Promise<{ externalId: string }>;
  pushPayment(token: string, key: string, payment: AccountingPayment, mapping: Readonly<Record<string, string>>): Promise<{ externalId: string }>;
}

export async function connectAccounting(deps: { keyring: TenantKeyring; clock: Clock }, tx: TenantTx, provider: string, token: string, mapping: Readonly<Record<string, string>>): Promise<string> {
  const id = (await tx.insertInto('accounting_connections').values({ tenant_id: tx.scope.tenantId, region: tx.scope.region, provider, token_enc: Buffer.alloc(0), connected_at: deps.clock.now() }).returning('id').executeTakeFirstOrThrow()).id;
  // The token's own key: shredding it on disconnect makes every copy unreadable (§19.5, §6.3).
  await tx.updateTable('accounting_connections').set({ token_enc: await deps.keyring.seal(tx, { table: 'accounting_connections', column: 'token_enc', rowId: id, subject: id }, token) }).where('id', '=', id).execute();
  for (const [local, external] of Object.entries(mapping)) {
    await tx.insertInto('accounting_mappings').values({ tenant_id: tx.scope.tenantId, region: tx.scope.region, connection_id: id, local_account: local, external_code: external }).execute();
  }
  await appendAudit(tx, { type: 'accounting.connected', actor: { kind: 'user' }, subject: `accounting:${id}`, payload: { provider, mapped: Object.keys(mapping).length } });
  return id;
}

export async function disconnectAccounting(deps: { keyring: TenantKeyring; clock: Clock }, tx: TenantTx, connectionId: string): Promise<void> {
  await deps.keyring.shredSubject(tx, connectionId, deps.clock.now());
  await tx.updateTable('accounting_connections').set({ token_enc: null, status: 'disconnected', disconnected_at: deps.clock.now() }).where('id', '=', connectionId).execute();
  await appendAudit(tx, { type: 'accounting.disconnected', actor: { kind: 'user' }, subject: `accounting:${connectionId}`, payload: { token: 'shredded' } });
}

export interface SyncResult { readonly pushed: number; readonly skipped: number; readonly failed: number }

/** Pushes every issued invoice and recorded payment not yet in the books. Reads in one transaction, calls the provider outside it, logs in another. */
export async function syncAccounting(deps: { db: Db; keyring: TenantKeyring; clock: Clock }, scope: TenantScope, port: AccountingPort, onFailure?: (tx: TenantTx, message: string) => Promise<void>): Promise<SyncResult> {
  const plan = await withTenant(deps.db, scope, async (tx) => {
    const conn = await tx.selectFrom('accounting_connections').selectAll().where('status', '=', 'connected').where('provider', '=', port.name).executeTakeFirst();
    if (!conn?.token_enc) return null;
    const token = await deps.keyring.openText(tx, { table: 'accounting_connections', column: 'token_enc', rowId: conn.id }, conn.token_enc);
    const mapping = Object.fromEntries((await tx.selectFrom('accounting_mappings').select(['local_account', 'external_code']).where('connection_id', '=', conn.id).execute()).map((m) => [m.local_account, m.external_code]));
    const done = new Set((await tx.selectFrom('accounting_sync_log').select('idempotency_key').where('status', '=', 'pushed').execute()).map((r) => r.idempotency_key));
    const invoices = await tx.selectFrom('invoices').selectAll().select(sql<string | null>`due_on::text`.as('due')).where('status', 'in', ['issued', 'part_paid', 'paid']).where('kind', '=', 'invoice').execute();
    const items: { key: string; entity: 'invoice' | 'payment'; entityId: string; invoice?: AccountingInvoice; payment?: AccountingPayment }[] = [];
    for (const i of invoices) {
      const key = `invoice:${i.id}`;
      if (done.has(key) || !i.number || !i.issued_at) continue;
      const lines = await tx.selectFrom('invoice_lines').select(['description', 'quantity', 'unit_minor']).where('invoice_id', '=', i.id).orderBy('position').execute();
      items.push({ key, entity: 'invoice', entityId: i.id, invoice: {
        number: i.number, issuedOn: i.issued_at.toISOString().slice(0, 10), dueOn: i.due, currency: i.currency,
        netMinor: Number(i.net_minor), vatMinor: Number(i.vat_minor), totalMinor: Number(i.total_minor), lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitMinor: Number(l.unit_minor) })),
      } });
    }
    const payments = await tx.selectFrom('payment_events').innerJoin('invoices', 'invoices.id', 'payment_events.invoice_id')
      .select(['payment_events.id', 'payment_events.amount_minor', 'payment_events.currency', 'payment_events.occurred_at', 'payment_events.provider_event_id', 'invoices.number'])
      .where('payment_events.kind', '=', 'payment_succeeded').execute();
    for (const p of payments) {
      const key = `payment:${p.id}`;
      if (done.has(key) || !p.number) continue;
      items.push({ key, entity: 'payment', entityId: p.id, payment: { invoiceNumber: p.number, amountMinor: Number(p.amount_minor), currency: p.currency, paidOn: p.occurred_at.toISOString().slice(0, 10), reference: p.provider_event_id } });
    }
    // Invoices before their payments, so the books always have something to pay against.
    items.sort((a, b) => (a.entity === b.entity ? 0 : a.entity === 'invoice' ? -1 : 1));
    return { connectionId: conn.id, token, mapping, items };
  });
  if (!plan) return { pushed: 0, skipped: 0, failed: 0 };
  let pushed = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const item of plan.items) {
    let externalId: string | null = null;
    let error: string | null = null;
    try {
      externalId = item.invoice ? (await port.pushInvoice(plan.token, item.key, item.invoice, plan.mapping)).externalId : (await port.pushPayment(plan.token, item.key, item.payment as AccountingPayment, plan.mapping)).externalId;
    } catch (err) {
      error = (err as Error).message.slice(0, 300);
    }
    await withTenant(deps.db, scope, (tx) => tx.insertInto('accounting_sync_log').values({
      tenant_id: scope.tenantId, region: scope.region, connection_id: plan.connectionId, entity: item.entity, entity_id: item.entityId, idempotency_key: item.key,
      external_id: externalId, status: error ? 'failed' : 'pushed', error, attempted_at: deps.clock.now(),
    }).onConflict((oc) => oc.doNothing()).execute());
    if (error) { failed++; failures.push(`${item.entity} ${item.invoice?.number ?? item.payment?.invoiceNumber ?? ''}: ${error}`); } else pushed++;
  }
  if (failures.length && onFailure) await withTenant(deps.db, scope, (tx) => onFailure(tx, failures.join('; ')));
  return { pushed, skipped: 0, failed };
}

/** Deterministic accounting provider for tests: idempotent on the key, with failure injection. */
export class FakeAccounting implements AccountingPort {
  readonly name = 'fakebooks';
  readonly egressHosts: readonly string[] = [];
  readonly invoices = new Map<string, AccountingInvoice>();
  readonly payments = new Map<string, AccountingPayment>();
  failNext = 0;
  async pushInvoice(token: string, key: string, invoice: AccountingInvoice) {
    if (!token) throw new Error('not authorised');
    if (this.failNext > 0) { this.failNext--; throw new Error('provider unavailable (503)'); }
    this.invoices.set(key, invoice);
    return { externalId: `fb_inv_${this.invoices.size}` };
  }
  async pushPayment(token: string, key: string, payment: AccountingPayment) {
    if (!token) throw new Error('not authorised');
    if (this.failNext > 0) { this.failNext--; throw new Error('provider unavailable (503)'); }
    this.payments.set(key, payment);
    return { externalId: `fb_pay_${this.payments.size}` };
  }
}
