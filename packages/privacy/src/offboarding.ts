/**
 * A business leaving Sevari (§21.1), and keeping every case owned (§21.3, T-OFF-1).
 *   exportTenantBundle()  the business's own data, portable and machine-readable, with only the fields the
 *                         registry declares for export (F20).
 *   requestOffboarding()  notice, then a grace window during which the export can still be downloaded.
 *   eraseTenant()         only after the grace window and only with Veylith's recorded decision (§8.3):
 *                         processor tokens revoked, channels switched off, portal links destroyed, every key
 *                         shredded (business, people, tokens), people deleted; statutory money records kept
 *                         without links to anyone; a certificate of erasure (F21).
 *   casesWithoutOwner()   anything open with nobody responsible (must always be zero).
 *   disableUser()         a team member leaving hands their open work back to the owner first.
 */
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { enqueue, selectColumns, sql, type TenantTx } from '@sevari/db';
import { ContractViolation } from '@sevari/domain';
import { TENANT_EXPORT, tenantExportIsDeclared } from './registry.ts';
import type { ShredRegister } from './shred-register.ts';

export const NOTICE_DAYS = 30;
export const GRACE_DAYS = 30;

export async function exportTenantBundle(deps: { keyring: TenantKeyring; clock: Clock }, tx: TenantTx): Promise<{ generated_at: string; tables: Record<string, Record<string, unknown>[]> }> {
  const problems = tenantExportIsDeclared();
  if (problems.length) throw new ContractViolation('F20', problems.join('; '));
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const [table, spec] of Object.entries(TENANT_EXPORT)) {
    const cols = [...spec.plain, ...(spec.sealed ?? [])];
    const needsId = (spec.sealed?.length ?? 0) > 0 && !spec.plain.includes('id');
    const rows = await selectColumns(tx, table, [...cols, ...(needsId ? ['id'] : [])]);
    const out: Record<string, unknown>[] = [];
    for (const r of rows) {
      const row: Record<string, unknown> = {};
      for (const c of spec.plain) row[c] = r[c] instanceof Date ? (r[c] as Date).toISOString() : r[c];
      for (const c of spec.sealed ?? []) {
        const v = r[c];
        row[c] = Buffer.isBuffer(v) ? await deps.keyring.openText(tx, { table, column: c, rowId: String(r['id']) }, v).catch(() => null) : null;
      }
      out.push(row);
    }
    tables[table] = out;
  }
  await tx.updateTable('tenant_offboardings').set({ exported_at: deps.clock.now() }).where('status', 'in', ['notice', 'grace']).execute();
  await appendAudit(tx, { type: 'tenant.exported', actor: { kind: 'user' }, subject: `tenant:${tx.scope.tenantId}`, payload: Object.fromEntries(Object.entries(tables).map(([t, r]) => [t, r.length])) });
  return { generated_at: deps.clock.now().toISOString(), tables };
}

export async function requestOffboarding(deps: { clock: Clock }, tx: TenantTx, reason: 'owner' | 'non_payment' | 'veylith'): Promise<{ id: string; noticeUntil: Date; graceUntil: Date }> {
  const now = deps.clock.nowMs();
  const noticeUntil = new Date(now + NOTICE_DAYS * 86_400_000);
  const graceUntil = new Date(noticeUntil.getTime() + GRACE_DAYS * 86_400_000);
  const r = await tx.insertInto('tenant_offboardings').values({ tenant_id: tx.scope.tenantId, region: tx.scope.region, reason, requested_at: new Date(now), notice_until: noticeUntil, grace_until: graceUntil })
    .returning('id').executeTakeFirstOrThrow();
  // The final bill for Sevari itself, at the end of the notice (§21.1). The job checks the request still stands.
  await enqueue(tx, { kind: 'offboarding.final_bill', dedupeKey: `final-bill:${r.id}`, runAt: noticeUntil, payload: { offboarding_id: r.id } });
  await appendAudit(tx, { type: 'tenant.offboarding_requested', actor: { kind: reason === 'owner' ? 'user' : 'operator' }, subject: `tenant:${tx.scope.tenantId}`, payload: { reason, notice_until: noticeUntil.toISOString(), grace_until: graceUntil.toISOString() } });
  return { id: r.id, noticeUntil, graceUntil };
}

export interface TenantErasureCertificate {
  readonly tenant: string;
  readonly erased_at: string;
  readonly decision: string;
  readonly keys_shredded: number;
  readonly people_deleted: number;
  readonly processor_tokens_revoked: number;
  readonly channels_disabled: number;
  readonly portal_links_destroyed: number;
  readonly open_items_closed: number;
  readonly retained: readonly { readonly table: string; readonly reason: string }[];
}

/** The business changed its mind before erasure: nothing is deleted, and the final bill does not run. */
export async function cancelOffboarding(tx: TenantTx): Promise<boolean> {
  const r = await tx.updateTable('tenant_offboardings').set({ status: 'cancelled' }).where('status', 'in', ['notice', 'grace']).returning('id').executeTakeFirst();
  if (!r) return false;
  await appendAudit(tx, { type: 'tenant.offboarding_cancelled', actor: { kind: 'user' }, subject: `tenant:${tx.scope.tenantId}`, payload: { offboarding_id: r.id } });
  return true;
}

export async function eraseTenant(deps: { keyring: TenantKeyring; clock: Clock; register?: ShredRegister }, tx: TenantTx): Promise<TenantErasureCertificate> {
  const now = deps.clock.now();
  const ob = await tx.selectFrom('tenant_offboardings').selectAll().where('status', 'in', ['notice', 'grace']).forUpdate().executeTakeFirst();
  if (!ob) throw new ContractViolation('§21.1', 'no offboarding is in progress for this business');
  if (ob.grace_until.getTime() > now.getTime()) throw new ContractViolation('§21.1', `the grace window runs until ${ob.grace_until.toISOString().slice(0, 10)}; nothing is erased before then`);
  const decision = await tx.selectFrom('platform_decisions').select('id').where('scope', '=', `tenant:${tx.scope.tenantId}:erasure`).where('decision', '=', 'signoff')
    .where('approver_role', '=', 'founder').where(sql<boolean>`expires_on >= current_date`).executeTakeFirst();
  if (!decision) throw new ContractViolation('§8.3', 'final erasure needs Veylith\'s recorded decision');
  // Processor offboarding first (§21.1): tokens, channels, links.
  const tokens = await tx.updateTable('accounting_connections').set({ token_enc: null, status: 'disconnected', disconnected_at: now }).where('status', '<>', 'disconnected').returning('id').execute();
  const channels = await tx.updateTable('channel_endpoints').set({ status: 'disabled' }).where('status', '=', 'active').returning('id').execute();
  const links = await tx.deleteFrom('portal_tokens').returning('id').execute();
  const questions = await tx.updateTable('human_questions').set({ status: 'cancelled', closed_reason: 'business_erased', next_escalation_at: null, reply_due_at: null }).where('status', '=', 'open').returning('id').execute();
  await tx.updateTable('outbox').set({ state: 'blocked', last_error: 'business_erased' }).where('state', '=', 'reserved').execute();
  // Every key: the business's, every person's and every token's. Copies anywhere become unreadable.
  const keys = await deps.keyring.shredAll(tx, now);
  await deps.register?.append({ at: now.toISOString(), tenantId: tx.scope.tenantId, region: tx.scope.region, kind: 'tenant', reason: 'tenant_exit' });
  const people = Number((await tx.deleteFrom('contacts').executeTakeFirst()).numDeletedRows);
  await tx.updateTable('tenants').set({ status: 'closed' }).where('id', '=', tx.scope.tenantId).execute();
  const cert: TenantErasureCertificate = {
    tenant: tx.scope.tenantId, erased_at: now.toISOString(), decision: decision.id, keys_shredded: keys, people_deleted: people,
    processor_tokens_revoked: tokens.length, channels_disabled: channels.length, portal_links_destroyed: links.length, open_items_closed: questions.length,
    retained: [
      { table: 'invoices, invoice_lines, ledger, payment_events', reason: 'statutory accounting and tax records (6 years); no longer linked to any person' },
      { table: 'audit_events', reason: 'tamper-evident record of decisions; ids and codes only' },
      { table: 'erasure_log, tenant_offboardings', reason: 'proof that erasure happened' },
    ],
  };
  await tx.updateTable('tenant_offboardings').set({ status: 'erased', erasure_decision_id: decision.id, certificate: JSON.stringify(cert), erased_at: now }).where('id', '=', ob.id).execute();
  await appendAudit(tx, { type: 'tenant.erased', actor: { kind: 'operator', ref: `decision:${decision.id}` }, subject: `tenant:${tx.scope.tenantId}`, payload: { keys_shredded: keys, people_deleted: people, tokens: tokens.length, channels: channels.length } });
  return cert;
}

/** T-OFF-1: open work with nobody responsible. Must always be empty. */
export async function casesWithoutOwner(tx: TenantTx): Promise<{ kind: string; id: string }[]> {
  const q = await tx.selectFrom('human_questions').leftJoin('users', 'users.id', 'human_questions.assigned_user_id').select('human_questions.id')
    .where('human_questions.status', '=', 'open').where((eb) => eb.or([eb('human_questions.assigned_user_id', 'is', null), eb('users.status', '<>', 'active')])).execute();
  const c = await tx.selectFrom('complaint_cases').leftJoin('users', 'users.id', 'complaint_cases.assigned_user_id').select('complaint_cases.id')
    .where('complaint_cases.status', 'in', ['open', 'remedy_proposed']).where((eb) => eb.or([eb('complaint_cases.assigned_user_id', 'is', null), eb('users.status', '<>', 'active')])).execute();
  const o = await tx.selectFrom('offloads').innerJoin('users', 'users.id', 'offloads.owner_user_id').select('offloads.id')
    .where('offloads.status', '=', 'awaiting_approval').where('users.status', '<>', 'active').execute();
  return [...q.map((r) => ({ kind: 'question', id: r.id })), ...c.map((r) => ({ kind: 'complaint', id: r.id })), ...o.map((r) => ({ kind: 'offload', id: r.id }))];
}

/** A team member leaving: their open work goes back to the owner before they're switched off. */
export async function disableUser(tx: TenantTx, userId: string): Promise<{ reassigned: number }> {
  const u = await tx.selectFrom('users').select(['role', 'status']).where('id', '=', userId).forUpdate().executeTakeFirstOrThrow();
  if (u.role === 'owner') throw new ContractViolation('§82', 'the owner can\'t be switched off; hand ownership over first');
  const owner = await tx.selectFrom('users').select('id').where('role', '=', 'owner').where('status', '=', 'active').executeTakeFirst();
  if (!owner) throw new ContractViolation('§82', 'this business has no active owner to hand work to');
  const q = await tx.updateTable('human_questions').set({ assigned_user_id: owner.id }).where('assigned_user_id', '=', userId).where('status', '=', 'open').returning('id').execute();
  const c = await tx.updateTable('complaint_cases').set({ assigned_user_id: owner.id }).where('assigned_user_id', '=', userId).where('status', 'in', ['open', 'remedy_proposed']).returning('id').execute();
  const o = await tx.updateTable('offloads').set({ owner_user_id: owner.id }).where('owner_user_id', '=', userId).where('status', '=', 'awaiting_approval').returning('id').execute();
  await tx.updateTable('users').set({ status: 'disabled' }).where('id', '=', userId).execute();
  await appendAudit(tx, { type: 'user.disabled', actor: { kind: 'user' }, subject: `user:${userId}`, payload: { reassigned_to: `user:${owner.id}`, items: q.length + c.length + o.length } });
  return { reassigned: q.length + c.length + o.length };
}
