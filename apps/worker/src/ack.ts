/**
 * Job `ack.send` (§5.2 ACK, F7): deterministic, never touches inference, sent within the ACK target.
 * Screen first (no I/O, milliseconds):
 *   STOP / opt-out     → suppress, send nothing (§50.3, F39)
 *   risk to life       → the pack's safety-first message (§42)
 *   always-human list  → holding acknowledgement only (§20.2)
 *   otherwise          → standard acknowledgement
 * Every message is rendered from a fixed template, grounded, reserved in the outbox and dispatched.
 */
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { withTenant, type Db, type TenantTx } from '@sevari/db';
import { ALWAYS_HUMAN_FLAGS, ContractViolation, sensitiveFlags, type TenantScope } from '@sevari/domain';
import { ground } from '@sevari/grounding';
import { snapshotAt } from '@sevari/knowledge';
import { dispatch, recordReply, reserve, suppress, updateReplyResult, type OutboundProvider } from '@sevari/outbound';
import { render, type TemplateId } from '@sevari/templates';
import { packFor } from '@sevari/verticals';

export { ACK_JOB } from '@sevari/intake';

export interface AckDeps {
  readonly db: Db;
  readonly keyring: TenantKeyring;
  readonly clock: Clock;
  readonly provider: OutboundProvider;
}

export type AckOutcome = 'deferred' | 'sent' | 'suppressed' | 'opted_out' | 'blocked' | 'already' | 'no_channel' | 'failed' | 'ambiguous' | 'in_progress' | 'not_dispatchable' | 'already_sent';

/** Prepares the ACK inside the job's tenant transaction; dispatch happens after commit. */
async function prepare(deps: AckDeps, tx: TenantTx, messageId: string): Promise<{ outboxId: string; replyId: string; receivedAt: number } | { outcome: AckOutcome }> {
  const prior = await tx.selectFrom('outbox').select(['id', 'state']).where('in_reply_to', '=', messageId).where('purpose', 'in', ['ack', 'safety', 'holding']).executeTakeFirst();
  if (prior) return prior.state === 'reserved' ? { outboxId: prior.id, replyId: '', receivedAt: deps.clock.nowMs() } : { outcome: 'already' };

  const m = await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id')
    .innerJoin('contacts', 'contacts.id', 'conversations.contact_id')
    .select(['messages.id', 'messages.channel', 'messages.body_enc', 'messages.subject_enc', 'messages.received_at', 'messages.conversation_id', 'contacts.id as contact_id', 'contacts.email_enc', 'contacts.phone_enc'])
    .where('messages.id', '=', messageId).executeTakeFirst();
  if (!m) throw new ContractViolation('§5.2', `message ${messageId} not found`);
  const open = (table: string, column: string, rowId: string, enc: Buffer) => deps.keyring.openText(tx, { table, column, rowId }, enc);
  const text = await open('messages', 'body_enc', m.id, m.body_enc);
  const email = m.email_enc ? await open('contacts', 'email_enc', m.contact_id, m.email_enc) : null;
  const phone = m.phone_enc ? await open('contacts', 'phone_enc', m.contact_id, m.phone_enc) : null;
  // Reply on the channel they used; forms and API go to email, or SMS when only a phone was given.
  const channel: 'email' | 'sms' | null = m.channel === 'sms' ? (phone ? 'sms' : null) : email ? 'email' : phone ? 'sms' : null;
  const recipient = channel === 'email' ? email : phone;
  const receivedAt = new Date(m.received_at).getTime();
  const flags = sensitiveFlags(text);

  if (flags.includes('opt_out')) {
    for (const [kind, value] of [['sms', phone], ['email', email]] as const) {
      if (value) await suppress(tx, deps.keyring, { channel: kind, recipient: value, recipientKind: kind, reason: 'stop_keyword', sourceRef: `message:${m.id}` });
    }
    await recordReply(tx, { inboundMessageId: m.id, purpose: 'ack', channel: m.channel, generator: 'template', factsUsed: [], factsMissing: [], groundingOk: true, autonomyDecision: 'none_opt_out', sendResult: 'opted_out', latencyMs: {} });
    return { outcome: 'opted_out' };
  }
  if (!channel || !recipient) {
    await appendAudit(tx, { type: 'ack.no_channel', actor: { kind: 'system' }, subject: `message:${m.id}`, payload: {} });
    return { outcome: 'no_channel' };
  }

  const knowledge = await snapshotAt(tx, deps.keyring, deps.clock.nowMs());
  const business = knowledge.business;
  const templateId: TemplateId = flags.includes('risk_to_life') ? 'safety' : flags.some((f) => ALWAYS_HUMAN_FLAGS.has(f)) ? 'holding' : 'ack';
  const pack = business ? packFor(business.body.vertical) : null;
  const rendered = business
    ? render(templateId, channel, {
      business: business.body.trading_name, replyTime: business.body.reply_time_statement, privacyUrl: business.body.privacy_notice_url,
      discloseAutomation: true, ...(pack?.safetyMessage ? { safetyMessage: pack.safetyMessage } : {}),
    })
    : { ok: false as const, reason: 'no confirmed business record' };
  if (!rendered.ok) {
    // §50.3: a missing value means no send and an owner task, never a gap in the message.
    await recordReply(tx, { inboundMessageId: m.id, purpose: templateId, channel, generator: 'template', templateId, factsUsed: [], factsMissing: [`template:${rendered.reason}`], groundingOk: false, autonomyDecision: 'auto_ack', sendResult: 'blocked_template', latencyMs: {} });
    await appendAudit(tx, { type: 'ack.blocked', actor: { kind: 'system' }, subject: `message:${m.id}`, payload: { reason: 'template', template: templateId } });
    return { outcome: 'blocked' };
  }

  if (!business) return { outcome: 'blocked' };
  const purpose = templateId === 'safety' ? 'safety' : templateId === 'holding' ? 'holding' : 'ack';
  const factTexts = [
    `${business.body.trading_name} ${business.body.reply_time_statement} ${business.body.privacy_notice_url}`,
    ...(pack?.safetyMessage ? [pack.safetyMessage] : []),
  ];
  const g = ground(rendered.text, purpose, { factTexts, factIds: [`${business.id}@${business.version}`], customerText: text }, { nowMs: deps.clock.nowMs(), timezone: knowledge.hours?.body.timezone ?? 'Europe/London' });
  if (!g.ok) {
    await recordReply(tx, { inboundMessageId: m.id, purpose, channel, generator: 'template', templateId, factsUsed: [], factsMissing: [], groundingOk: false, groundingFailures: g.failures, autonomyDecision: 'auto_ack', sendResult: 'blocked_grounding', latencyMs: {} });
    return { outcome: 'blocked' };
  }
  const r = await reserve(tx, deps.keyring, deps.clock, {
    draft: g.draft, conversationId: m.conversation_id, contactId: m.contact_id, inReplyTo: m.id, channel, recipient,
    actionClass: 'ack', dedupeKey: `${m.id}:ack`, templateId, templateVersion: rendered.version,
  });
  const replyId = await recordReply(tx, {
    inboundMessageId: m.id, outboxId: r.outboxId, purpose, channel, generator: 'template', templateId, factsUsed: g.draft.factsUsed, factsMissing: [],
    groundingOk: true, autonomyDecision: 'auto_ack', sendResult: r.status === 'suppressed' ? 'suppressed' : 'reserved',
    latencyMs: { received_to_reserved: deps.clock.nowMs() - receivedAt },
  });
  if (r.status === 'suppressed') return { outcome: 'suppressed' };
  return { outboxId: r.outboxId, replyId, receivedAt };
}

export async function sendAck(deps: AckDeps, scope: TenantScope, messageId: string): Promise<AckOutcome> {
  const prepared = await withTenant(deps.db, scope, (tx) => prepare(deps, tx, messageId));
  if ('outcome' in prepared) return prepared.outcome;
  const result = await dispatch(deps, scope, prepared.outboxId);
  if (prepared.replyId) {
    await withTenant(deps.db, scope, (tx) => updateReplyResult(tx, prepared.replyId, result, { received_to_provider_accepted: deps.clock.nowMs() - prepared.receivedAt }));
  }
  return result;
}
