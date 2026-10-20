/**
 * Job `enquiry.respond` (§5.2 after analysis). Turns the deterministic analysis into either:
 *   - a draft reply (route answer or clarify), sent under an autonomy grant or put to a human for
 *     approval (assist mode is the default, §81.3); or
 *   - an owner task (route unknown or human_only): the customer already has the acknowledgement, and a
 *     person decides what happens next (§5.4, §20.2).
 * Safety-first and opt-out routes were fully handled by the ACK step. Idempotent per enquiry.
 */
import { decide, revokeAll, revokeAutonomy } from '@sevari/autonomy';
import type { TenantKeyring } from '@sevari/crypto';
import type { Clock } from '@sevari/clock';
import type { TenantTx } from '@sevari/db';
import { factsBundle, replySections, type ActionClass, type EnquiryAnalysis } from '@sevari/domain';
import { ground } from '@sevari/grounding';
import { ask, digestOf, type ConsumerRegistry } from '@sevari/hitl';
import { classifyRightsRequest, openDsar } from '@sevari/privacy';
import { snapshotAt } from '@sevari/knowledge';
import { recordReply } from '@sevari/outbound';
import { render } from '@sevari/templates';
import { createDraft, sendDraft } from './sending.ts';

export interface RespondDeps {
  readonly keyring: TenantKeyring;
  readonly clock: Clock;
  readonly consumers: ConsumerRegistry;
}

/** How long a reply waits for approval before closing to its safe default (nothing sent). */
export const APPROVAL_DEADLINE_MS = 72 * 3_600_000;

export function actionClassFor(a: EnquiryAnalysis): ActionClass {
  return a.intent.intent === 'quote_request' ? 'quote_reply' : 'info_reply';
}

export async function respond(deps: RespondDeps, tx: TenantTx, enquiryId: string): Promise<{ outcome: string }> {
  const e = await tx.selectFrom('enquiries').selectAll().where('id', '=', enquiryId).executeTakeFirst();
  if (!e) return { outcome: 'not_found' };
  const already = await tx.selectFrom('drafts').select('id').where('enquiry_id', '=', enquiryId).executeTakeFirst()
    ?? await tx.selectFrom('human_questions').select('id').where('subject_ref', '=', `enquiry:${enquiryId}`).executeTakeFirst();
  if (already) return { outcome: 'already' };
  if (e.route === 'safety_first' || e.route === 'opt_out') return { outcome: `handled_by_ack:${e.route}` };

  const a = JSON.parse(await deps.keyring.openText(tx, { table: 'enquiries', column: 'analysis_enc', rowId: e.id }, e.analysis_enc)) as EnquiryAnalysis;
  if (a.intent.intent === 'complaint' || a.flags.includes('complaint')) await revokeAll(tx, 'complaint');

  const c = await customerOf(deps, tx, e.message_id);
  const snap = await snapshotAt(tx, deps.keyring, deps.clock.nowMs());
  const business = snap.business?.body;
  const tenant = await tx.selectFrom('tenants').select(['reply_due_minutes']).where('id', '=', tx.scope.tenantId).executeTakeFirstOrThrow();
  const replyDueAt = new Date(c.receivedAt + tenant.reply_due_minutes * 60_000);

  const ownerTask = (title: string, summary: string, facts: readonly string[] = []) => ask({ ...deps }, tx, {
    subjectContactId: c.contactId,
    kind: 'owner_task', subjectRef: `enquiry:${enquiryId}`, contentDigest: digestOf({ enquiry: enquiryId, route: e.route, analysed_at: e.analysed_at.toISOString() }), requiredRole: 'owner',
    body: {
      title, summary, preview: c.text, facts,
      optionLabels: { reply: 'Write a reply', handled: 'I have dealt with it' }, safeDefaultText: 'Nothing is sent to the customer until you decide.',
    },
    options: ['reply', 'handled'], safeDefault: 'hold', consumer: { kind: 'owner.task', ref: enquiryId }, deadlineMs: APPROVAL_DEADLINE_MS,
  });

  if (e.route === 'human_only' && (a.intent.intent === 'data_rights' || a.flags.includes('data_rights'))) {
    await rightsRequest(deps, tx, enquiryId, c);
    return { outcome: 'dsar_opened' };
  }
  if (e.route === 'human_only') {
    await ownerTask('This one needs you', 'Sevari does not answer this kind of message by itself. The customer has had a holding reply.', a.flags.map((fl) => `Flag: ${fl.replace(/_/g, ' ')}`));
    return { outcome: 'owner_task' };
  }
  if (e.route === 'unknown' || !business || !c.channel || !c.recipient) {
    const missing = a.factsMissing.map((m) => `Not in your records yet: ${m.replace(/^knowledge:/, '').replace(/[:_]/g, ' ')}`);
    await ownerTask('A customer asked something Sevari can\'t answer yet', c.channel ? 'Your records don\'t cover this yet. The customer has had the acknowledgement.' : 'There is no way to reply to this customer automatically.', missing);
    return { outcome: 'owner_task' };
  }

  // answer or clarify: the deterministic reply from confirmed facts.
  const bundle = factsBundle(a, snap);
  const actionClass = actionClassFor(a);
  const values = { business: business.trading_name, replyTime: business.reply_time_statement, privacyUrl: business.privacy_notice_url, discloseAutomation: false };
  const rendered = e.route === 'clarify'
    ? render('clarify', c.channel, { ...values, question: a.clarify?.question ?? '' })
    : render('reply', c.channel, { ...values, sections: replySections(a, snap) });
  const purpose = e.route === 'clarify' ? 'clarify' as const : 'reply' as const;
  const sources = { factTexts: [...bundle.texts, business.trading_name, business.privacy_notice_url], factIds: [...bundle.ids], customerText: c.text, services: bundle.services };
  const g = rendered.ok ? ground(rendered.text, purpose, sources, { nowMs: deps.clock.nowMs(), timezone: snap.hours?.body.timezone ?? 'Europe/London' }) : null;
  if (!rendered.ok || !g?.ok) {
    if (g && !g.ok) await revokeAutonomy(tx, actionClass, 'grounding_failure');
    await recordReply(tx, { inboundMessageId: e.message_id, enquiryId, purpose, channel: c.channel, intent: a.intent.intent, intentConfidence: a.intent.confidence, generator: 'template', ...(rendered.ok ? { templateId: rendered.templateId } : {}), factsUsed: bundle.ids, factsMissing: a.factsMissing, groundingOk: false, ...(g && !g.ok ? { groundingFailures: g.failures } : {}), autonomyDecision: 'blocked', sendResult: rendered.ok ? 'blocked_grounding' : 'blocked_template', latencyMs: {} });
    await ownerTask('Sevari couldn\'t write a safe reply', rendered.ok ? 'The reply it wrote didn\'t pass the fact check, so it was not sent.' : `The reply template is missing something (${rendered.reason}).`);
    return { outcome: 'owner_task_blocked' };
  }

  const draft = await createDraft(deps, tx, {
    enquiryId, conversationId: c.conversationId, contactId: c.contactId, inReplyTo: e.message_id, channel: c.channel, recipient: c.recipient,
    purpose, actionClass, body: g.draft.text, sources, generator: 'template', templateId: rendered.templateId, factsUsed: bundle.ids,
  });
  const decision = await decide(tx, actionClass);
  if (decision.mode === 'granted') {
    const r = await sendDraft(deps, tx, draft.id, { kind: 'grant', grantId: decision.grantId });
    if (r.status === 'queued') return { outcome: 'sent_under_grant' };
    if (r.reason !== 'approval') {
      if (r.reason === 'grounding') await revokeAutonomy(tx, actionClass, 'grounding_failure');
      await ownerTask('A reply was stopped before sending', 'Sevari stopped its own reply at the last check, so nothing was sent.');
      return { outcome: `owner_task_${r.reason}` };
    }
  }
  await ask({ ...deps }, tx, {
    subjectContactId: c.contactId,
    kind: 'approve_draft', subjectRef: `draft:${draft.id}`, actionClass, contentDigest: draft.digest, requiredRole: 'approver',
    body: {
      title: purpose === 'clarify' ? 'Question for the customer, ready to approve' : 'Reply ready to approve',
      summary: `Written from your confirmed records${a.services.length ? ` about ${a.services.map((s) => s.replace(/_/g, ' ')).join(', ')}` : ''}. Nothing is sent until you approve it.`,
      preview: g.draft.text, facts: bundle.texts,
      optionLabels: { approve: 'Send it', edit: 'Change it', reject: 'Don\'t send' }, safeDefaultText: 'Nothing is sent until someone approves it.',
    },
    options: ['approve', 'edit', 'reject'], safeDefault: 'hold', consumer: { kind: 'draft.send', ref: draft.id }, deadlineMs: APPROVAL_DEADLINE_MS, replyDueAt,
  });
  await recordReply(tx, { inboundMessageId: e.message_id, enquiryId, purpose, channel: c.channel, intent: a.intent.intent, intentConfidence: a.intent.confidence, generator: 'template', templateId: rendered.templateId, factsUsed: bundle.ids, factsMissing: a.factsMissing, groundingOk: true, autonomyDecision: decision.mode === 'approval' ? `approval:${decision.reason}` : 'approval:grant_refused', sendResult: 'awaiting_approval', latencyMs: {} });
  return { outcome: 'awaiting_approval' };
}

export interface CustomerRef {
  readonly messageId: string;
  readonly conversationId: string;
  readonly contactId: string;
  readonly receivedAt: number;
  readonly text: string;
  readonly channel: 'email' | 'sms' | null;
  readonly recipient: string | null;
  /** The channel the message arrived on. */
  readonly via: string;
}

/** Reply on the channel they used; forms and API go to email, or SMS when only a phone was given. */
export async function customerOf(deps: { keyring: TenantKeyring }, tx: TenantTx, messageId: string): Promise<CustomerRef> {
  const m = await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id')
    .innerJoin('contacts', 'contacts.id', 'conversations.contact_id')
    .select(['messages.id', 'messages.channel', 'messages.body_enc', 'messages.received_at', 'messages.conversation_id', 'contacts.id as contact_id', 'contacts.email_enc', 'contacts.phone_enc'])
    .where('messages.id', '=', messageId).executeTakeFirstOrThrow();
  const open = (table: string, column: string, rowId: string, enc: Buffer) => deps.keyring.openText(tx, { table, column, rowId }, enc);
  const email = m.email_enc ? await open('contacts', 'email_enc', m.contact_id, m.email_enc) : null;
  const phone = m.phone_enc ? await open('contacts', 'phone_enc', m.contact_id, m.phone_enc) : null;
  const channel: 'email' | 'sms' | null = m.channel === 'sms' ? (phone ? 'sms' : null) : email ? 'email' : phone ? 'sms' : null;
  return {
    messageId: m.id, conversationId: m.conversation_id, contactId: m.contact_id, receivedAt: new Date(m.received_at).getTime(),
    text: await open('messages', 'body_enc', m.id, m.body_enc), channel, recipient: channel === 'email' ? email : phone, via: m.channel,
  };
}

const KIND_TEXT: Record<string, string> = {
  access: 'a copy of the information you hold about them',
  portability: 'their information in a form they can take elsewhere',
  erasure: 'their information to be deleted',
  rectification: 'their details to be corrected',
  objection: 'you to stop using their information for something',
  restriction: 'you to limit how their information is used',
  unspecified: 'something about their personal information (it isn\'t clear exactly what)',
};

/**
 * A data-rights request (§21.2): opened with its legal clock, and put to the owner (the controller) to
 * release. Sevari assembles and executes; the decision is human (§8.3). The customer already has the
 * holding acknowledgement.
 */
async function rightsRequest(deps: RespondDeps, tx: TenantTx, enquiryId: string, c: CustomerRef): Promise<void> {
  const kind = classifyRightsRequest(c.text);
  const identity = c.via === 'email' || c.via === 'sms' ? 'channel_verified' as const : 'unverified' as const;
  const d = await openDsar(tx, { contactId: c.contactId, sourceMessageId: c.messageId, kind, identity, receivedAt: new Date(c.receivedAt) });
  const options = kind === 'access' || kind === 'portability' ? ['release', 'refuse'] : kind === 'erasure' ? ['erase', 'refuse'] : ['done', 'refuse'];
  const labels: Record<string, string> = { release: 'Send them their copy', erase: 'Delete their information', done: 'I have dealt with it', refuse: 'Refuse (you must tell them why)' };
  const q = await ask({ ...deps }, tx, {
    subjectContactId: c.contactId, kind: 'dsar_release', subjectRef: `dsar:${d.id}`, contentDigest: digestOf({ dsar: d.id, kind }), requiredRole: 'owner',
    body: {
      title: 'A customer has asked about their personal information',
      summary: `They have asked for ${KIND_TEXT[kind]}. The law gives you until ${d.dueAt.toISOString().slice(0, 10)} to respond.${identity === 'unverified' ? ' It came through your website form, so check it is really them before you act.' : ''}`,
      preview: c.text, optionLabels: Object.fromEntries(options.map((o) => [o, labels[o] ?? o])),
      safeDefaultText: 'Nothing is sent or deleted until you decide. You will be reminded before the deadline.',
    },
    options, safeDefault: 'escalate', consumer: { kind: 'dsar.release', ref: d.id }, deadlineMs: Math.max(60_000, d.dueAt.getTime() - deps.clock.nowMs()),
    replyDueAt: new Date(d.dueAt.getTime() - 7 * 86_400_000),
  });
  await tx.updateTable('dsar_requests').set({ question_id: q }).where('id', '=', d.id).execute();
}
