/**
 * The autonomy engine (§7.2). For each action class a tenant is either in assist mode (every send needs
 * a human approval) or holds an earned, revocable grant. A grant needs ALL of: the owner's explicit
 * decision (a human input), a clean rolling window of drafts, and a class that isn't reserved.
 * The system can only ever revoke a grant on its own (kill switch); granting is always human.
 */
import { appendAudit } from '@sevari/audit';
import { sql, type TenantTx } from '@sevari/db';
import { ContractViolation, isActionClass, type ActionClass } from '@sevari/domain';
import { ALWAYS_AUTOMATIC, NEVER_GRANTABLE } from './reserved.ts';

export interface Thresholds {
  /** Drafts in the rolling window (§7.2: N ≥ 50). */
  readonly windowN: number;
  /** Maximum owner edit rate in the window. */
  readonly maxEditRate: number;
}
/** Defaults. Changing them is a human decision (§7.2), never a model's or the system's. */
export const DEFAULT_THRESHOLDS: Thresholds = Object.freeze({ windowN: 50, maxEditRate: 0.1 });

export type Decision =
  | { readonly mode: 'automatic'; readonly reason: 'always_automatic' }
  | { readonly mode: 'granted'; readonly grantId: string }
  | { readonly mode: 'approval'; readonly reason: 'never_grantable' | 'no_grant' };

export async function decide(tx: TenantTx, actionClass: ActionClass): Promise<Decision> {
  if (ALWAYS_AUTOMATIC.has(actionClass)) return { mode: 'automatic', reason: 'always_automatic' };
  if (NEVER_GRANTABLE.has(actionClass)) return { mode: 'approval', reason: 'never_grantable' };
  const g = await tx.selectFrom('autonomy_grants').select('id').where('action_class', '=', actionClass).where('revoked_at', 'is', null).executeTakeFirst();
  return g ? { mode: 'granted', grantId: g.id } : { mode: 'approval', reason: 'no_grant' };
}

export interface Evidence {
  readonly drafts: number;
  readonly edited: number;
  readonly editRate: number;
  readonly groundingFailures: number;
  readonly complaints: number;
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

/** The rolling window of the last N drafts of a class (§7.2). Codes and counts only. */
export async function evidenceFor(tx: TenantTx, actionClass: ActionClass, t: Thresholds = DEFAULT_THRESHOLDS): Promise<Evidence> {
  const recent = await tx.selectFrom('drafts').select(['id', 'parent_id', 'generator', 'status', 'conversation_id', 'created_at'])
    .where('action_class', '=', actionClass).where('parent_id', 'is', null).where('status', 'in', ['sent', 'superseded', 'rejected', 'approved'])
    .orderBy('created_at', 'desc').limit(t.windowN).execute();
  const ids = recent.map((d) => d.id);
  const edited = ids.length ? (await tx.selectFrom('drafts').select('parent_id').where('parent_id', 'in', ids).groupBy('parent_id').execute()).length : 0;
  const since = recent.at(-1)?.created_at;
  const groundingFailures = since ? (await tx.selectFrom('reply_records').select('id').where('purpose', '=', 'reply').where('grounding_ok', '=', false).where('created_at', '>=', since).execute()).length : 0;
  const complaints = since ? (await tx.selectFrom('enquiries').select('id').where('intent', '=', 'complaint').where('analysed_at', '>=', since).execute()).length : 0;
  const editRate = ids.length ? edited / ids.length : 1;
  const reasons: string[] = [];
  if (NEVER_GRANTABLE.has(actionClass) || ALWAYS_AUTOMATIC.has(actionClass)) reasons.push('class_not_grantable');
  if (ids.length < t.windowN) reasons.push(`needs_${t.windowN}_drafts_has_${ids.length}`);
  if (groundingFailures > 0) reasons.push('grounding_failures_in_window');
  if (editRate > t.maxEditRate) reasons.push('edit_rate_above_threshold');
  if (complaints > 0) reasons.push('complaints_in_window');
  return { drafts: ids.length, edited, editRate: Math.round(editRate * 1000) / 1000, groundingFailures, complaints, eligible: reasons.length === 0, reasons };
}

/** Grants autonomy for one class. Only called by the consumer of an owner's answered question. */
export async function grantAutonomy(tx: TenantTx, input: { actionClass: string; inputId: string; grantedBy: string; thresholds?: Thresholds }): Promise<string> {
  if (!isActionClass(input.actionClass)) throw new ContractViolation('§7.2', `unknown action class ${input.actionClass}`);
  if (NEVER_GRANTABLE.has(input.actionClass) || ALWAYS_AUTOMATIC.has(input.actionClass)) throw new ContractViolation('INV-11', `${input.actionClass} can never be granted autonomy`);
  const ev = await evidenceFor(tx, input.actionClass, input.thresholds);
  if (!ev.eligible) throw new ContractViolation('§7.2', `not eligible: ${ev.reasons.join(', ')}`);
  const row = await tx.insertInto('autonomy_grants').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, action_class: input.actionClass, input_id: input.inputId, granted_by: input.grantedBy, evidence: JSON.stringify(ev),
  }).returning('id').executeTakeFirstOrThrow();
  await appendAudit(tx, { type: 'autonomy.granted', actor: { kind: 'user', ref: input.grantedBy }, subject: `grant:${row.id}`, payload: { action_class: input.actionClass, drafts: ev.drafts, edit_rate: ev.editRate } });
  return row.id;
}

/** Kill switch (§7.2): any grounding failure, complaint or anomaly drops the class back to assist mode. */
export async function revokeAutonomy(tx: TenantTx, actionClass: string, reason: 'grounding_failure' | 'complaint' | 'anomaly' | 'owner'): Promise<boolean> {
  const r = await tx.updateTable('autonomy_grants').set({ revoked_at: sql<Date>`clock_timestamp()`, revoke_reason: reason })
    .where('action_class', '=', actionClass).where('revoked_at', 'is', null).returning('id').executeTakeFirst();
  if (r) await appendAudit(tx, { type: 'autonomy.revoked', actor: { kind: 'system' }, subject: `grant:${r.id}`, payload: { action_class: actionClass, reason } });
  return Boolean(r);
}

/** Every active grant is revoked when the tenant receives a complaint (§7.2 kill switch). */
export async function revokeAll(tx: TenantTx, reason: 'complaint' | 'anomaly' | 'owner'): Promise<number> {
  const rows = await tx.updateTable('autonomy_grants').set({ revoked_at: sql<Date>`clock_timestamp()`, revoke_reason: reason }).where('revoked_at', 'is', null).returning(['id', 'action_class']).execute();
  for (const r of rows) await appendAudit(tx, { type: 'autonomy.revoked', actor: { kind: 'system' }, subject: `grant:${r.id}`, payload: { action_class: r.action_class, reason } });
  return rows.length;
}
