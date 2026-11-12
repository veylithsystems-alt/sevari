/**
 * Outbound sends (contract §5.2 outbox, §17.2 suppression, Part J §66 delivery ambiguity).
 *
 *   reserve()   inside the business transaction: suppression check under a recipient lock, then an
 *               outbox row in state `reserved`. Unique dedupe key: one send per purpose per source.
 *   dispatch()  tx1 marks `sending` (lease) and re-checks suppression → provider call → tx2 records
 *               `sent` / `failed`, or `ambiguous` when the outcome is unknown.
 *   reconcile() resolves `ambiguous` and expired `sending` rows by asking the provider. Consequential
 *               classes are never retried automatically: they wait for a human.
 *
 * Only a GroundedDraft can be reserved, so ungrounded text can't reach a provider (INV-5).
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { lockOutbox, lockRecipient, sql, withTenant, type Db, type TenantTx } from '@sevari/db';
import { ContractViolation, normaliseEmail, normalisePhone, type TenantScope } from '@sevari/domain';
import { isGroundedDraft, type GroundedDraft } from '@sevari/grounding';
import type { OutboundProvider } from './provider.ts';
import { checkSendPolicy, type PolicyRefusal, type PreferenceRegister } from './policy.ts';

/** Classes that never auto-retry an ambiguous send (Part J §66, F50). */
export const CONSEQUENTIAL = new Set(['payment_request', 'cancel', 'booking_change', 'refund', 'invoice_send', 'booking_create', 'quote_reply']);

export interface ReserveInput {
  readonly draft: GroundedDraft;
  readonly conversationId: string;
  readonly contactId: string;
  readonly inReplyTo?: string;
  readonly channel: 'email' | 'sms';
  readonly recipient: string;
  readonly actionClass: string;
  readonly dedupeKey: string;
  readonly templateId?: string;
  readonly templateVersion?: string;
  /** The cell's preference register (TPS, CTPS); none configured means anything needing one is refused. */
  readonly register?: PreferenceRegister;
}

export type ReserveResult =
  | { readonly status: 'reserved'; readonly outboxId: string; readonly created: boolean; readonly notBefore: Date | null }
  | { readonly status: 'suppressed'; readonly outboxId: string }
  /** The contact rules (§17.2) say no: recorded as blocked, with the reason, never sent. */
  | { readonly status: 'refused'; readonly outboxId: string; readonly reason: PolicyRefusal };

const field = (column: string, rowId: string) => ({ table: 'outbox', column, rowId });

export function normaliseRecipient(channel: 'email' | 'sms', raw: string): string {
  const v = channel === 'email' ? normaliseEmail(raw) : normalisePhone(raw);
  if (!v) throw new ContractViolation('§5.2', `invalid ${channel} recipient`);
  return v;
}

export const recipientIndex = (keyring: TenantKeyring, tx: TenantTx, channel: 'email' | 'sms', normalised: string) =>
  keyring.index(tx, channel === 'email' ? 'email' : 'phone', normalised);

async function isSuppressed(tx: TenantTx, channel: 'email' | 'sms', bidx: Buffer): Promise<boolean> {
  const hit = await tx.selectFrom('suppressions').select('id').where('recipient_bidx', '=', bidx).where('channel_scope', 'in', [channel, 'all']).executeTakeFirst();
  return Boolean(hit);
}

export async function reserve(tx: TenantTx, keyring: TenantKeyring, clock: Clock, input: ReserveInput): Promise<ReserveResult> {
  if (!isGroundedDraft(input.draft)) throw new ContractViolation('INV-5', 'only a grounded draft can be sent');
  const existing = await tx.selectFrom('outbox').select(['id', 'state', 'last_error', 'not_before']).where('dedupe_key', '=', input.dedupeKey).executeTakeFirst();
  if (existing) {
    if (existing.state !== 'blocked') return { status: 'reserved', outboxId: existing.id, created: false, notBefore: existing.not_before };
    return existing.last_error?.startsWith('policy:') ? { status: 'refused', outboxId: existing.id, reason: existing.last_error.slice(7) as PolicyRefusal } : { status: 'suppressed', outboxId: existing.id };
  }

  const to = normaliseRecipient(input.channel, input.recipient);
  const bidx = await recipientIndex(keyring, tx, input.channel, to);
  await lockRecipient(tx, bidx);
  const suppressed = await isSuppressed(tx, input.channel, bidx);
  // The contact rules, under the same lock: provenance, tier, purpose, recipient class, registers, caps.
  const policy = suppressed ? null : await checkSendPolicy(tx, clock, {
    contactId: input.contactId, channel: input.channel, purpose: input.draft.purpose, recipient: to, body: input.draft.text,
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}), ...(input.register ? { register: input.register } : {}),
  });
  const refused = policy && !policy.ok ? policy.reason : null;
  const blocked = suppressed || refused !== null;
  const id = randomUUID();
  const bytes = Buffer.from(input.draft.text, 'utf8');
  await tx.insertInto('outbox').values({
    id, tenant_id: tx.scope.tenantId, region: tx.scope.region, conversation_id: input.conversationId, contact_id: input.contactId,
    in_reply_to: input.inReplyTo ?? null, channel: input.channel, purpose: input.draft.purpose, action_class: input.actionClass,
    dedupe_key: input.dedupeKey, recipient_enc: await keyring.seal(tx, { ...field('recipient_enc', id), subject: input.contactId }, to), recipient_bidx: bidx,
    body_enc: await keyring.seal(tx, { ...field('body_enc', id), subject: input.contactId }, bytes), body_digest: createHash('sha256').update(bytes).digest(),
    template_id: input.templateId ?? null, template_version: input.templateVersion ?? null,
    reserved_at: clock.now(), initiative: policy?.initiative ?? 'response', not_before: policy?.ok ? policy.notBefore : null,
    ...(blocked ? { state: 'blocked' as const, last_error: suppressed ? 'suppressed' : `policy:${refused}` } : {}),
  }).execute();
  await appendAudit(tx, {
    type: suppressed ? 'send.suppressed' : refused ? 'send.refused' : 'send.reserved', actor: { kind: 'system' }, subject: `outbox:${id}`,
    payload: { purpose: input.draft.purpose, channel: input.channel, action_class: input.actionClass, facts_used: input.draft.factsUsed.length, ...(refused ? { reason: refused } : {}), ...(policy?.ok && policy.notBefore ? { not_before: policy.notBefore.toISOString() } : {}) },
  });
  if (suppressed) return { status: 'suppressed', outboxId: id };
  if (refused) return { status: 'refused', outboxId: id, reason: refused };
  return { status: 'reserved', outboxId: id, created: true, notBefore: policy?.ok ? policy.notBefore : null };
}

export type DispatchResult = 'sent' | 'already_sent' | 'in_progress' | 'suppressed' | 'failed' | 'ambiguous' | 'not_dispatchable' | 'deferred';

export interface DispatchDeps {
  readonly db: Db;
  readonly keyring: TenantKeyring;
  readonly clock: Clock;
  readonly provider: OutboundProvider;
  readonly leaseMs?: number;
}

export async function dispatch(deps: DispatchDeps, scope: TenantScope, outboxId: string): Promise<DispatchResult> {
  // tx1: claim the send. Re-check suppression under the recipient lock: an opt-out that landed after
  // reservation still wins (F9).
  const claim = await withTenant(deps.db, scope, async (tx) => {
    await lockOutbox(tx, outboxId);
    const row = await tx.selectFrom('outbox').selectAll().where('id', '=', outboxId).executeTakeFirst();
    if (!row) throw new ContractViolation('§5.2', 'outbox row not found');
    if (row.state === 'sent') return { kind: 'done' as const, result: 'already_sent' as const };
    if (row.state === 'sending' && row.lease_until && row.lease_until.getTime() > deps.clock.nowMs()) return { kind: 'done' as const, result: 'in_progress' as const };
    if (row.state !== 'reserved') return { kind: 'done' as const, result: 'not_dispatchable' as const };
    // Quiet hours (F13): a proactive message waits for the sending window, whoever asks to send it early.
    if (row.not_before && row.not_before.getTime() > deps.clock.nowMs()) return { kind: 'done' as const, result: 'deferred' as const };
    await lockRecipient(tx, row.recipient_bidx);
    if (await isSuppressed(tx, row.channel as 'email' | 'sms', row.recipient_bidx)) {
      await tx.updateTable('outbox').set({ state: 'blocked', last_error: 'suppressed' }).where('id', '=', outboxId).execute();
      await appendAudit(tx, { type: 'send.suppressed', actor: { kind: 'system' }, subject: `outbox:${outboxId}`, payload: { at: 'dispatch' } });
      return { kind: 'done' as const, result: 'suppressed' as const };
    }
    await tx.updateTable('outbox').set({ state: 'sending', attempts: row.attempts + 1, lease_until: new Date(deps.clock.nowMs() + (deps.leaseMs ?? 30_000)), provider: deps.provider.name, dispatched_at: sql<Date>`clock_timestamp()` })
      .where('id', '=', outboxId).execute();
    const to = await deps.keyring.openText(tx, field('recipient_enc', outboxId), row.recipient_enc);
    const text = await deps.keyring.openText(tx, field('body_enc', outboxId), row.body_enc);
    // An email answer goes out with the business's receiving address as reply-to, so the customer's reply returns here.
    const via = row.channel === 'email' && row.in_reply_to
      ? await tx.selectFrom('messages').innerJoin('channel_endpoints', 'channel_endpoints.id', 'messages.endpoint_id').select('channel_endpoints.inbound_address')
        .where('messages.id', '=', row.in_reply_to).executeTakeFirst()
      : undefined;
    return { kind: 'send' as const, env: { reference: outboxId, channel: row.channel as 'email' | 'sms', to, text, ...(via?.inbound_address ? { replyTo: via.inbound_address } : {}) } };
  });
  if (claim.kind === 'done') return claim.result;

  let outcome: Awaited<ReturnType<OutboundProvider['send']>> | { status: 'unknown'; error: string };
  try {
    outcome = await deps.provider.send(claim.env);
  } catch (err) {
    outcome = { status: 'unknown', error: (err as Error).message };
  }

  // tx2: record the outcome.
  return withTenant(deps.db, scope, async (tx) => {
    await lockOutbox(tx, outboxId);
    if (outcome.status === 'accepted') {
      await tx.updateTable('outbox').set({ state: 'sent', provider_message_id: outcome.providerMessageId, sent_at: deps.clock.now(), lease_until: null })
        .where('id', '=', outboxId).where('state', '=', 'sending').execute();
      await appendAudit(tx, { type: 'send.sent', actor: { kind: 'provider', ref: deps.provider.name }, subject: `outbox:${outboxId}`, payload: { provider_message_ref: outcome.providerMessageId } });
      return 'sent';
    }
    if (outcome.status === 'rejected') {
      await tx.updateTable('outbox').set({ state: 'failed', last_error: outcome.reason.slice(0, 200), lease_until: null }).where('id', '=', outboxId).execute();
      if (outcome.suppress) {
        const row = await tx.selectFrom('outbox').select(['channel', 'recipient_bidx']).where('id', '=', outboxId).executeTakeFirstOrThrow();
        await suppressByIndex(tx, row.channel as 'email' | 'sms', row.recipient_bidx, 'provider_block', `outbox:${outboxId}`);
      }
      await appendAudit(tx, { type: 'send.failed', actor: { kind: 'provider', ref: deps.provider.name }, subject: `outbox:${outboxId}`, payload: { suppress: outcome.suppress } });
      return 'failed';
    }
    if (outcome.status === 'deferred') {
      // The provider said "not now": nothing went out, so it goes back to the queue unchanged.
      await tx.updateTable('outbox').set({ state: 'reserved', last_error: outcome.reason.slice(0, 200), lease_until: null }).where('id', '=', outboxId).where('state', '=', 'sending').execute();
      await appendAudit(tx, { type: 'send.deferred', actor: { kind: 'provider', ref: deps.provider.name }, subject: `outbox:${outboxId}`, payload: {} });
      return 'deferred';
    }
    await tx.updateTable('outbox').set({ state: 'ambiguous', last_error: outcome.error.slice(0, 200), lease_until: null }).where('id', '=', outboxId).execute();
    await appendAudit(tx, { type: 'send.ambiguous', actor: { kind: 'provider', ref: deps.provider.name }, subject: `outbox:${outboxId}`, payload: {} });
    return 'ambiguous';
  });
}

export type ReconcileResult = 'confirmed_sent' | 'requeued' | 'needs_human' | 'nothing_to_do';

/**
 * Resolves an `ambiguous` (or lease-expired `sending`) send by asking the provider whether it has our
 * reference. Found → sent. Not found → safe classes go back to `reserved` (the provider's idempotency key
 * prevents a double send even if the first request arrives late); consequential classes wait for a human.
 */
export async function reconcile(deps: DispatchDeps, scope: TenantScope, outboxId: string): Promise<ReconcileResult> {
  const row = await withTenant(deps.db, scope, (tx) => tx.selectFrom('outbox').select(['state', 'lease_until', 'action_class']).where('id', '=', outboxId).executeTakeFirst());
  if (!row) return 'nothing_to_do';
  const stale = row.state === 'sending' && (!row.lease_until || row.lease_until.getTime() <= deps.clock.nowMs());
  if (row.state !== 'ambiguous' && !stale) return 'nothing_to_do';
  const found = deps.provider.supportsLookup ? await deps.provider.lookup(outboxId) : null;
  return withTenant(deps.db, scope, async (tx) => {
    await lockOutbox(tx, outboxId);
    if (found) {
      await tx.updateTable('outbox').set({ state: 'sent', provider_message_id: found.providerMessageId, sent_at: deps.clock.now(), lease_until: null }).where('id', '=', outboxId).execute();
      await appendAudit(tx, { type: 'send.reconciled', actor: { kind: 'system' }, subject: `outbox:${outboxId}`, payload: { outcome: 'sent' } });
      return 'confirmed_sent';
    }
    const safeToRetry = !CONSEQUENTIAL.has(row.action_class) && deps.provider.supportsLookup && deps.provider.supportsIdempotencyKey;
    if (safeToRetry) {
      await tx.updateTable('outbox').set({ state: 'reserved', lease_until: null }).where('id', '=', outboxId).execute();
      await appendAudit(tx, { type: 'send.reconciled', actor: { kind: 'system' }, subject: `outbox:${outboxId}`, payload: { outcome: 'requeued' } });
      return 'requeued';
    }
    await tx.updateTable('outbox').set({ state: 'ambiguous', lease_until: null }).where('id', '=', outboxId).execute();
    await appendAudit(tx, { type: 'send.needs_human', actor: { kind: 'system' }, subject: `outbox:${outboxId}`, payload: { action_class: row.action_class } });
    return 'needs_human';
  });
}

async function suppressByIndex(tx: TenantTx, channel: 'email' | 'sms' | 'all', bidx: Buffer, reason: 'stop_keyword' | 'opt_out_request' | 'provider_block' | 'owner' | 'complaint', sourceRef: string): Promise<boolean> {
  await lockRecipient(tx, bidx);
  const r = await tx.insertInto('suppressions').values({ tenant_id: tx.scope.tenantId, region: tx.scope.region, channel_scope: channel, recipient_bidx: bidx, reason, source_ref: sourceRef })
    .onConflict((oc) => oc.columns(['tenant_id', 'channel_scope', 'recipient_bidx']).doNothing()).returning('id').executeTakeFirst();
  if (r) await appendAudit(tx, { type: 'suppression.added', actor: { kind: 'customer' }, subject: `suppression:${r.id}`, payload: { channel, reason, source_ref: sourceRef } });
  return Boolean(r);
}

/** STOP and opt-outs: effective before any further send to this recipient (§17.2, §50.3). */
export async function suppress(tx: TenantTx, keyring: TenantKeyring, input: { channel: 'email' | 'sms' | 'all'; recipient: string; recipientKind: 'email' | 'sms'; reason: 'stop_keyword' | 'opt_out_request' | 'owner' | 'complaint'; sourceRef: string }): Promise<boolean> {
  const to = normaliseRecipient(input.recipientKind, input.recipient);
  const bidx = await recipientIndex(keyring, tx, input.recipientKind, to);
  return suppressByIndex(tx, input.channel, bidx, input.reason, input.sourceRef);
}
