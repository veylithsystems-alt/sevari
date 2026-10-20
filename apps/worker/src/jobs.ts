/**
 * The worker's job table: one place that wires every job kind to its handler.
 *   inbound.process  → analysis (optional model fallback)          inbound.ts
 *   ack.send         → deterministic acknowledgement                ack.ts
 *   enquiry.respond  → draft + approval question, or owner task     respond.ts
 *   draft.dispatch   → provider send, then the effect receipt       here
 *   outbox.dispatch  → provider send for system messages            here
 *   outbox.reconcile → resolve an ambiguous send, never blind-retry  here
 *   hitl.sweep       → escalation, reply-due, deadlines, receipts   @sevari/hitl
 */
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { enqueue, withTenant, type Db } from '@sevari/db';
import type { TenantScope } from '@sevari/domain';
import { completeEffect, SWEEP_JOB, sweep, type ConsumerRegistry } from '@sevari/hitl';
import { ACK_JOB, INBOUND_JOB } from '@sevari/intake';
import { dispatch, reconcile, recordReply, type OutboundProvider } from '@sevari/outbound';
import { sendAck } from './ack.ts';
import { DSAR_ERASE_JOB, makeConsumers } from './consumers.ts';
import { eraseSubject, type ShredRegister } from '@sevari/privacy';
import { inboundHandler, RESPOND_JOB, type ModelDeps } from './inbound.ts';
import { respond } from './respond.ts';
import type { JobHandler } from './runner.ts';
import { clockTime, DISPATCH_JOB, OUTBOX_DISPATCH_JOB, RECONCILE_JOB } from './sending.ts';

export interface WorkerDeps {
  readonly db: Db;
  readonly keyring: TenantKeyring;
  readonly clock: Clock;
  readonly provider: OutboundProvider;
  readonly model?: ModelDeps;
  /** The cell's public origin, for links in messages. */
  readonly publicBaseUrl?: string;
  /** The shred register outside the database (§67). Required in production by the boot check. */
  readonly shredRegister?: ShredRegister;
}

const RECONCILE_AFTER_MS = 60_000;

export function workerHandlers(deps: WorkerDeps): { handlers: Record<string, JobHandler>; consumers: ConsumerRegistry } {
  const consumers = makeConsumers({ keyring: deps.keyring, clock: deps.clock, ...(deps.publicBaseUrl ? { publicBaseUrl: deps.publicBaseUrl } : {}) });
  const hitl = { keyring: deps.keyring, clock: deps.clock, consumers };

  /** Records the outcome of a draft send on the draft, the reply record and the human's receipt (§74.2). */
  const settle = async (scope: TenantScope, draftId: string, outboxId: string, inputId: string | null, grantId: string | null, result: string) => {
    await withTenant(deps.db, scope, async (tx) => {
      const draft = await tx.selectFrom('drafts').select(['id', 'enquiry_id', 'in_reply_to', 'channel', 'purpose', 'generator', 'template_id', 'facts_used']).where('id', '=', draftId).executeTakeFirstOrThrow();
      const status = result === 'sent' || result === 'already_sent' || result === 'confirmed_sent' ? 'sent'
        : result === 'failed' ? 'failed' : result === 'suppressed' || result === 'not_dispatchable' ? 'blocked' : null;
      if (status) await tx.updateTable('drafts').set({ status }).where('id', '=', draftId).execute();
      if (result === 'ambiguous' || result === 'requeued') return;
      if (status) {
        await recordReply(tx, {
          ...(draft.in_reply_to ? { inboundMessageId: draft.in_reply_to } : {}), ...(draft.enquiry_id ? { enquiryId: draft.enquiry_id } : {}), outboxId,
          purpose: draft.purpose, channel: draft.channel, generator: draft.generator, ...(draft.template_id ? { templateId: draft.template_id } : {}),
          factsUsed: draft.facts_used, factsMissing: [], groundingOk: true, autonomyDecision: grantId ? `grant:${grantId}` : 'approved', sendResult: status, latencyMs: {},
        });
      }
      if (!inputId) return;
      if (status === 'sent') await completeEffect(hitl, tx, inputId, { effectKind: 'message.sent', effectRef: `outbox:${outboxId}`, outcome: 'done', text: `Sent to the customer at ${clockTime(deps.clock.nowMs())}.` });
      else if (status === 'failed') await completeEffect(hitl, tx, inputId, { effectKind: 'message.sent', effectRef: `outbox:${outboxId}`, outcome: 'failed', text: 'The message could not be delivered to the customer. Please contact them another way; nothing will be re-sent automatically.' });
      else if (status === 'blocked') await completeEffect(hitl, tx, inputId, { effectKind: 'message.sent', effectRef: `outbox:${outboxId}`, outcome: 'failed', text: 'Not sent: this customer has asked not to be contacted.' });
      else if (result === 'needs_human') await completeEffect(hitl, tx, inputId, { effectKind: 'message.sent', effectRef: `outbox:${outboxId}`, outcome: 'failed', text: 'We could not confirm whether your message reached the customer, so it was not re-sent automatically (to avoid a duplicate). Please check with them.' });
    });
  };

  const handlers: Record<string, JobHandler> = {
    [INBOUND_JOB]: inboundHandler(deps.db, { keyring: deps.keyring, clock: deps.clock, ...(deps.model ? { model: deps.model } : {}) }),
    [ACK_JOB]: { scoped: (scope, p) => sendAck(deps, scope, String(p['message_id'])) },
    [RESPOND_JOB]: (tx, p) => respond(hitl, tx, String(p['enquiry_id'])),
    [SWEEP_JOB]: (tx) => sweep(hitl, tx),
    [DISPATCH_JOB]: {
      scoped: async (scope, p) => {
        const outboxId = String(p['outbox_id']);
        const draftId = String(p['draft_id']);
        const inputId = p['input_id'] ? String(p['input_id']) : null;
        const grantId = p['grant_id'] ? String(p['grant_id']) : null;
        const result = await dispatch(deps, scope, outboxId);
        if (result === 'in_progress') throw new Error('send in progress elsewhere; retry later');
        if (result === 'ambiguous') {
          await withTenant(deps.db, scope, (tx) => enqueue(tx, { kind: RECONCILE_JOB, dedupeKey: `reconcile:${outboxId}`, runAt: new Date(deps.clock.nowMs() + RECONCILE_AFTER_MS), payload: { outbox_id: outboxId, draft_id: draftId, input_id: inputId, grant_id: grantId } }));
        }
        await settle(scope, draftId, outboxId, inputId, grantId, result);
        return result;
      },
    },
    [OUTBOX_DISPATCH_JOB]: {
      scoped: async (scope, p) => {
        const result = await dispatch(deps, scope, String(p['outbox_id']));
        if (result === 'in_progress') throw new Error('send in progress elsewhere; retry later');
        return result;
      },
    },
    [DSAR_ERASE_JOB]: {
      scoped: async (scope, p) => {
        const dsarId = String(p['dsar_id']);
        const outboxId = p['outbox_id'] ? String(p['outbox_id']) : null;
        // Wait until the confirmation has gone (or failed for good): erasing first would erase the message too.
        if (outboxId) {
          // Send it now if it hasn't gone yet (dispatch is idempotent and lease-protected).
          const r = await dispatch(deps, scope, outboxId);
          if (r === 'in_progress') throw new Error('confirmation is being sent elsewhere; erase after it');
          if (r === 'ambiguous') await reconcile(deps, scope, outboxId);
        }
        return withTenant(deps.db, scope, async (tx) => {
          const cert = await eraseSubject({ keyring: deps.keyring, clock: deps.clock, ...(deps.shredRegister ? { register: deps.shredRegister } : {}) }, tx, String(p['contact_id']), 'dsar_erasure', `dsar:${dsarId}`);
          await tx.updateTable('dsar_requests').set({ status: 'completed', outcome: 'erased', completed_at: deps.clock.now() }).where('id', '=', dsarId).execute();
          const n = Object.values(cert.deleted).reduce((a, b) => a + b, 0);
          if (p['input_id']) await completeEffect(hitl, tx, String(p['input_id']), { effectKind: 'subject.erased', effectRef: `dsar:${dsarId}`, outcome: 'done', text: `Done. Their information has been deleted (${n} records, and their encryption key destroyed, so no copy anywhere can be read). A certificate of erasure has been recorded.` });
          return 'erased';
        });
      },
    },
    [RECONCILE_JOB]: {
      scoped: async (scope, p) => {
        const outboxId = String(p['outbox_id']);
        const r = await reconcile(deps, scope, outboxId);
        const draftId = p['draft_id'] ? String(p['draft_id']) : null;
        if (r === 'requeued') {
          await withTenant(deps.db, scope, (tx) => enqueue(tx, { kind: draftId ? DISPATCH_JOB : OUTBOX_DISPATCH_JOB, dedupeKey: `redispatch:${outboxId}:${deps.clock.nowMs()}`, payload: { outbox_id: outboxId, draft_id: draftId, input_id: p['input_id'] ? String(p['input_id']) : null, grant_id: p['grant_id'] ? String(p['grant_id']) : null } }));
        }
        if (draftId) await settle(scope, draftId, outboxId, p['input_id'] ? String(p['input_id']) : null, p['grant_id'] ? String(p['grant_id']) : null, r);
        if (r === 'needs_human') await withTenant(deps.db, scope, (tx) => appendAudit(tx, { type: 'send.escalated', actor: { kind: 'system' }, subject: `outbox:${outboxId}`, payload: {} }));
        return r;
      },
    },
  };
  return { handlers, consumers };
}
