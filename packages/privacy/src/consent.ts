/**
 * The consent ledger (§17.2): append-only events per person, purpose and channel. The current state is
 * the latest event; a withdrawal always wins over an older grant, and takes effect at once.
 */
import { appendAudit } from '@sevari/audit';
import type { ConsentPurpose, TenantTx } from '@sevari/db';
import { ContractViolation } from '@sevari/domain';

export interface ConsentEvent {
  readonly contactId: string;
  readonly purpose: ConsentPurpose;
  readonly channel: 'email' | 'sms' | 'all';
  readonly action: 'granted' | 'withdrawn';
  readonly basis: string;
  readonly source: string;
  /** The exact wording version the person saw (required for a grant). */
  readonly wordingVersion?: string;
  readonly evidenceRef?: string;
  readonly at: Date;
}

export async function recordConsent(tx: TenantTx, e: ConsentEvent): Promise<string> {
  if (e.action === 'granted' && !e.wordingVersion) throw new ContractViolation('§17.2', 'a consent grant needs the wording version the person saw');
  const r = await tx.insertInto('consents').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, contact_id: e.contactId, purpose: e.purpose, channel: e.channel, action: e.action,
    basis: e.basis, source: e.source, wording_version: e.wordingVersion ?? null, evidence_ref: e.evidenceRef ?? null, recorded_at: e.at,
  }).returning('id').executeTakeFirstOrThrow();
  await appendAudit(tx, { type: `consent.${e.action}`, actor: { kind: 'customer', ref: `contact:${e.contactId}` }, subject: `consent:${r.id}`, payload: { purpose: e.purpose, channel: e.channel, source: e.source } });
  return r.id;
}

/** Whether the person currently consents to `purpose` on `channel`. No record means no. */
export async function hasConsent(tx: TenantTx, contactId: string, purpose: ConsentPurpose, channel: 'email' | 'sms'): Promise<boolean> {
  const latest = await tx.selectFrom('consents').select(['action']).where('contact_id', '=', contactId).where('purpose', '=', purpose)
    .where('channel', 'in', [channel, 'all']).orderBy('recorded_at', 'desc').orderBy('created_at', 'desc').limit(1).executeTakeFirst();
  return latest?.action === 'granted';
}
