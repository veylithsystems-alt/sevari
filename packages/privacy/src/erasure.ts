/**
 * Erasure of one person (§21.2, F5). Order matters:
 *   1. shred the person's own key: from this moment everything ever sealed with it is unreadable,
 *      including table residue, the write-ahead log, replicas and backups;
 *   2. delete their rows (the contact, and by cascade their conversations, messages, analyses, drafts,
 *      approvals, outbound messages and consents);
 *   3. zero the content digests left on decision records, and remove notices about them;
 *   4. keep what the law needs, holding no personal data in readable form: suppressions (so an opt-out
 *      is never forgotten), the data-rights request record, and an erasure log of ids and blind indexes
 *      (to re-apply the erasure if a backup is ever restored).
 * The caller must hold a human decision (§8.3: releasing a rights request). Idempotent.
 */
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { sql, type TenantTx } from '@sevari/db';
import type { ShredRegister } from './shred-register.ts';

export interface ErasureCertificate {
  readonly subject: string;
  readonly erasedAt: string;
  readonly reason: 'dsar_erasure' | 'retention' | 'tenant_exit';
  readonly keysShredded: number;
  readonly deleted: Readonly<Record<string, number>>;
  readonly zeroed: Readonly<Record<string, number>>;
  /** What was deliberately kept, and why. None of it is readable personal data. */
  readonly retained: readonly { readonly what: string; readonly why: string }[];
}

const ZERO = Buffer.alloc(32);

export async function eraseSubject(deps: { keyring: TenantKeyring; clock: Clock; register?: ShredRegister }, tx: TenantTx, contactId: string,
  reason: ErasureCertificate['reason'], requestRef: string | null): Promise<ErasureCertificate> {
  const prior = await tx.selectFrom('erasure_log').select('certificate').where('subject_ref', '=', contactId).executeTakeFirst();
  if (prior) return prior.certificate as unknown as ErasureCertificate;
  const contact = await tx.selectFrom('contacts').select(['id', 'email_bidx', 'phone_bidx']).where('id', '=', contactId).forUpdate().executeTakeFirst();
  const now = deps.clock.now();

  const count = async (table: 'conversations' | 'outbox' | 'drafts' | 'consents', col: 'contact_id') =>
    Number((await tx.selectFrom(table).select(sql<string>`count(*)`.as('n')).where(col, '=', contactId).executeTakeFirstOrThrow()).n);
  const convIds = (await tx.selectFrom('conversations').select('id').where('contact_id', '=', contactId).execute()).map((r) => r.id);
  const msgs = convIds.length ? Number((await tx.selectFrom('messages').select(sql<string>`count(*)`.as('n')).where('conversation_id', 'in', convIds).executeTakeFirstOrThrow()).n) : 0;
  const enqs = convIds.length ? Number((await tx.selectFrom('enquiries').select(sql<string>`count(*)`.as('n')).where('conversation_id', 'in', convIds).executeTakeFirstOrThrow()).n) : 0;
  const deleted: Record<string, number> = {
    contacts: contact ? 1 : 0, conversations: await count('conversations', 'contact_id'), messages: msgs, enquiries: enqs,
    drafts: await count('drafts', 'contact_id'), outbox: await count('outbox', 'contact_id'), consents: await count('consents', 'contact_id'),
  };

  // 1. The key first: if anything below fails, the data is already unreadable. Recorded outside the
  // database too, so a restore from an older backup can't bring the key back (§67, T-KEY-3).
  const keysShredded = await deps.keyring.shredSubject(tx, contactId, now);
  await deps.register?.append({ at: now.toISOString(), tenantId: tx.scope.tenantId, region: tx.scope.region, kind: 'subject', subjectRef: contactId, reason });

  // 3. Decision records about them keep their shape (who decided what, when) but lose the content.
  const qIds = (await tx.selectFrom('human_questions').select('id').where('subject_contact_id', '=', contactId).execute()).map((r) => r.id);
  let inputsZeroed = 0;
  if (qIds.length) {
    await tx.updateTable('human_questions').set({ content_digest: ZERO }).where('id', 'in', qIds).execute();
    await tx.updateTable('human_questions').set({ status: 'cancelled', closed_reason: 'person_erased', next_escalation_at: null, reply_due_at: null })
      .where('id', 'in', qIds).where('status', '=', 'open').execute();
    inputsZeroed = Number((await tx.updateTable('human_inputs').set({ response_digest: ZERO }).where('question_id', 'in', qIds).executeTakeFirst()).numUpdatedRows);
  }
  const notices = Number((await tx.deleteFrom('human_notifications').where('subject_contact_id', '=', contactId).executeTakeFirst()).numDeletedRows);
  deleted['human_notifications'] = notices;

  // 2. The rows. Deleting the contact cascades to everything that hangs off them.
  if (contact) await tx.deleteFrom('contacts').where('id', '=', contactId).execute();

  const certificate: ErasureCertificate = {
    subject: contactId, erasedAt: now.toISOString(), reason, keysShredded, deleted,
    zeroed: { human_questions: qIds.length, human_inputs: inputsZeroed },
    retained: [
      { what: 'opt-out suppressions (keyed blind index only)', why: 'so the person is never contacted again by mistake (PECR, §17.2)' },
      { what: 'data-rights request record (dates and outcome; any copy of the data is sealed with the shredded key)', why: 'proof the request was handled on time' },
      { what: 'decision records (who approved what, when; content unreadable, digests zeroed)', why: 'accountability (§30)' },
      { what: 'tamper-evident audit events (ids and codes only)', why: 'integrity of the record (INV-8)' },
      { what: 'this erasure log (ids and keyed blind indexes)', why: 're-apply this erasure if a backup is ever restored (F35)' },
    ],
  };
  await tx.insertInto('erasure_log').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, subject_ref: contactId,
    identifiers: [contact?.email_bidx, contact?.phone_bidx].filter((b): b is Buffer => Boolean(b)),
    reason, request_ref: requestRef, certificate: JSON.stringify(certificate), erased_at: now,
  }).execute();
  await appendAudit(tx, { type: 'subject.erased', actor: { kind: 'system' }, subject: `contact:${contactId}`, payload: { reason, keys_shredded: keysShredded, ...Object.fromEntries(Object.entries(deleted).map(([k, v]) => [`deleted_${k}`, v])), ...(requestRef ? { request_ref: requestRef } : {}) } });
  return certificate;
}

/**
 * Re-applies every logged erasure (after a backup restore, F35): any person in the log who is present
 * again is erased again; their keys are shredded again. Returns the number re-erased.
 */
export async function reapplyErasures(deps: { keyring: TenantKeyring; clock: Clock }, tx: TenantTx): Promise<number> {
  const log = await tx.selectFrom('erasure_log').select(['subject_ref', 'reason', 'request_ref']).execute();
  let n = 0;
  for (const e of log) {
    const back = await tx.selectFrom('contacts').select('id').where('id', '=', e.subject_ref).executeTakeFirst();
    const key = await tx.selectFrom('subject_keys').select('id').where('subject_ref', '=', e.subject_ref).where('state', '=', 'active').executeTakeFirst();
    if (!back && !key) continue;
    await deps.keyring.shredSubject(tx, e.subject_ref, deps.clock.now());
    if (back) await tx.deleteFrom('contacts').where('id', '=', e.subject_ref).execute();
    await appendAudit(tx, { type: 'subject.erasure_reapplied', actor: { kind: 'system' }, subject: `contact:${e.subject_ref}`, payload: { reason: e.reason } });
    n++;
  }
  return n;
}
