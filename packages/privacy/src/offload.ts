/**
 * Offloading a case to someone outside the business (§21.3, F19): a subcontractor, specialist, partner
 * firm, insurer, regulator or debt-recovery agent. The recipient must be an approved processor on the
 * supplier register or a partner the business has recorded with a lawful basis; anything else is refused.
 * Every handover is a human approval; regulator contact and debt recovery are always human.
 * Only the minimum fields named are bundled, sealed with the person's own key.
 */
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import type { TenantTx } from '@sevari/db';
import { ContractViolation } from '@sevari/domain';

export type OffloadPurpose = 'subcontract' | 'specialist' | 'partner_referral' | 'insurance' | 'regulator' | 'debt_recovery';
export const OFFLOAD_FIELDS = ['name', 'email', 'phone', 'service', 'booking_time', 'message_summary'] as const;
export type OffloadField = (typeof OFFLOAD_FIELDS)[number];

export interface OffloadRequest {
  readonly caseRef: string;
  readonly contactId: string | null;
  readonly recipient: { readonly partnerId: string } | { readonly processorId: string };
  readonly purpose: OffloadPurpose;
  readonly lawfulBasis: string;
  readonly fields: readonly OffloadField[];
  readonly ownerUserId: string;
}

export type OffloadResult = { readonly status: 'requested'; readonly id: string } | { readonly status: 'refused'; readonly reason: string };

/** Records the handover for approval, or refuses it (recorded) when the recipient isn't registered (F19). */
export async function requestOffload(deps: { clock: Clock; approvedProcessors: ReadonlySet<string> }, tx: TenantTx, r: OffloadRequest): Promise<OffloadResult> {
  const refuse = async (why: string): Promise<OffloadResult> => {
    await appendAudit(tx, { type: 'offload.refused', actor: { kind: 'user', ref: r.ownerUserId }, subject: `case:${r.caseRef.slice(0, 80)}`, payload: { reason: why, purpose: r.purpose } });
    return { status: 'refused', reason: why };
  };
  if (!r.lawfulBasis.trim()) return refuse('a handover needs a lawful basis');
  if (!r.fields.length || r.fields.some((f) => !OFFLOAD_FIELDS.includes(f))) return refuse('only the listed minimum fields can be handed over');
  if ('processorId' in r.recipient) {
    if (!deps.approvedProcessors.has(r.recipient.processorId)) return refuse(`"${r.recipient.processorId}" is not an approved supplier on the register`);
  } else {
    const p = await tx.selectFrom('partners').select(['enabled', 'relationship', 'dpa_ref', 'kind']).where('id', '=', r.recipient.partnerId).executeTakeFirst();
    if (!p || !p.enabled) return refuse('that partner is not registered with this business');
    if (p.relationship === 'processor' && !p.dpa_ref) return refuse('a processor partner needs a data processing agreement on record');
  }
  const row = await tx.insertInto('offloads').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, case_ref: r.caseRef, contact_id: r.contactId,
    partner_id: 'partnerId' in r.recipient ? r.recipient.partnerId : null, processor_id: 'processorId' in r.recipient ? r.recipient.processorId : null,
    purpose: r.purpose, lawful_basis: r.lawfulBasis, fields: [...r.fields], owner_user_id: r.ownerUserId,
  }).returning('id').executeTakeFirstOrThrow();
  await appendAudit(tx, { type: 'offload.requested', actor: { kind: 'user', ref: r.ownerUserId }, subject: `offload:${row.id}`, payload: { purpose: r.purpose, fields: r.fields } });
  void deps.clock;
  return { status: 'requested', id: row.id };
}

/** On the owner's approval: the minimum bundle, sealed with the person's key, ready to hand over. */
export async function approveOffload(deps: { keyring: TenantKeyring }, tx: TenantTx, offloadId: string, inputId: string): Promise<Record<string, string | null>> {
  const o = await tx.selectFrom('offloads').selectAll().where('id', '=', offloadId).forUpdate().executeTakeFirstOrThrow();
  if (o.status !== 'awaiting_approval') throw new ContractViolation('§21.3', 'this handover has already been decided');
  const bundle: Record<string, string | null> = {};
  if (o.contact_id) {
    const c = await tx.selectFrom('contacts').select(['id', 'display_name_enc', 'email_enc', 'phone_enc']).where('id', '=', o.contact_id).executeTakeFirst();
    const open = async (col: 'display_name_enc' | 'email_enc' | 'phone_enc') => (c?.[col] ? deps.keyring.openText(tx, { table: 'contacts', column: col, rowId: c.id }, c[col] as Buffer) : null);
    for (const f of o.fields) {
      if (f === 'name') bundle['name'] = await open('display_name_enc');
      if (f === 'email') bundle['email'] = await open('email_enc');
      if (f === 'phone') bundle['phone'] = await open('phone_enc');
    }
    if (o.fields.includes('booking_time') || o.fields.includes('service')) {
      const b = await tx.selectFrom('bookings').select(['service', 'starts_at']).where('contact_id', '=', o.contact_id).where('status', '=', 'confirmed').orderBy('starts_at').executeTakeFirst();
      if (o.fields.includes('service')) bundle['service'] = b?.service ?? null;
      if (o.fields.includes('booking_time')) bundle['booking_time'] = b?.starts_at.toISOString() ?? null;
    }
  }
  await tx.updateTable('offloads').set({
    status: 'approved', input_id: inputId,
    bundle_enc: await deps.keyring.seal(tx, { table: 'offloads', column: 'bundle_enc', rowId: offloadId, subject: o.contact_id }, JSON.stringify(bundle)),
  }).where('id', '=', offloadId).execute();
  await appendAudit(tx, { type: 'offload.approved', actor: { kind: 'user' }, subject: `offload:${offloadId}`, payload: { fields: o.fields } });
  return bundle;
}
