/**
 * Approvals (§7.1, I8, INV-4, F6). An approval authorises exactly one send of exactly one payload:
 *  - bound to the SHA-256 of the canonical payload {action class, channel, recipient, body};
 *  - expires (the expiry is checked inside the consuming statement, not in application code);
 *  - single-use: consumption is one UPDATE that only one caller can win, and a trigger makes a consumed
 *    approval immutable.
 * If consumption returns no row, the action does not happen.
 */
import { createHash } from 'node:crypto';
import { appendAudit } from '@sevari/audit';
import { sql, type TenantTx } from '@sevari/db';
import { canonicalJson } from '@sevari/domain';

export interface Payload {
  readonly actionClass: string;
  readonly channel: 'email' | 'sms';
  /** Normalised recipient (E.164 or lower-cased email). */
  readonly recipient: string;
  readonly body: string;
}

export const payloadDigest = (p: Payload): Buffer =>
  createHash('sha256').update(canonicalJson({ action_class: p.actionClass, channel: p.channel, recipient: p.recipient, body: p.body })).digest();

/** Default approval lifetime: long enough to send, short enough that it can't be saved up. */
export const APPROVAL_TTL_MS = 15 * 60_000;

export async function createApproval(tx: TenantTx, a: { draftId: string; actionClass: string; digest: Buffer; approverId: string; inputId: string; ttlMs?: number }): Promise<string> {
  const row = await tx.insertInto('approvals').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, draft_id: a.draftId, action_class: a.actionClass, content_digest: a.digest,
    approver_id: a.approverId, input_id: a.inputId,
    // Set by the database clock, the same clock that checks it on consumption (§7.1: expiry in the query).
    expires_at: sql<Date>`clock_timestamp() + make_interval(secs => ${(a.ttlMs ?? APPROVAL_TTL_MS) / 1000})`,
  }).returning('id').executeTakeFirstOrThrow();
  await appendAudit(tx, { type: 'approval.created', actor: { kind: 'user', ref: a.approverId }, subject: `approval:${row.id}`, payload: { draft_ref: `draft:${a.draftId}`, action_class: a.actionClass } });
  return row.id;
}

/**
 * Consumes an approval in one statement (§7.1). Returns true only for the single winning caller whose
 * digest matches and whose approval hasn't expired, measured by the database clock.
 */
export async function consumeApproval(tx: TenantTx, approvalId: string, digest: Buffer): Promise<boolean> {
  const r = await tx.updateTable('approvals').set({ consumed_at: sql<Date>`clock_timestamp()` })
    .where('id', '=', approvalId).where('consumed_at', 'is', null).where('expires_at', '>', sql<Date>`clock_timestamp()`).where('content_digest', '=', digest)
    .returning('id').executeTakeFirst();
  await appendAudit(tx, { type: r ? 'approval.consumed' : 'approval.refused', actor: { kind: 'system' }, subject: `approval:${approvalId}`, payload: {} });
  return Boolean(r);
}
