/**
 * What each kind of human answer does (INV-12: every question names one of these). Each consumer
 * acknowledges in plain English, applies the effect, and either finishes with a receipt now or hands the
 * receipt to the send job (which confirms "sent at 10:02" or reports the failure, §74.2).
 *
 *   draft.send       approve → send exactly this draft; edit → new version (re-checked; a changed fact
 *                    asks "one-off or update your records?", F25); reject → nothing sent.
 *   edit.clarify     the answer to that question.
 *   owner.task       the owner writes the reply themselves, or marks it handled.
 *   knowledge.update acknowledgement that a record should change (the change itself is owner-confirmed, I5).
 *   autonomy.grant   the owner's decision to let one action class send without asking (§7.2).
 */
import { grantAutonomy } from '@sevari/autonomy';
import { enqueue, type QuestionRow, type TenantTx } from '@sevari/db';
import { ground } from '@sevari/grounding';
import { ask, notify, type Consumer, type ConsumerContext, type ConsumerRegistry, type ConsumerResult } from '@sevari/hitl';
import { snapshotAt } from '@sevari/knowledge';
import { assembleCopy, DOWNLOAD_TTL_MS, prepareDownload } from '@sevari/privacy';
import { reserve } from '@sevari/outbound';
import { render } from '@sevari/templates';
import { releaseForDraft } from './bookings.ts';
import { releaseInvoiceDraft } from './invoicing.ts';
import { customerOf } from './respond.ts';
import { createDraft, loadDraft, OUTBOX_DISPATCH_JOB, refusalText, sendDraft, type SendDeps } from './sending.ts';

export const DSAR_ERASE_JOB = 'dsar.erase';

const ref = (q: QuestionRow) => q.consumer_ref;
const done = (effectKind: string, effectRef: string, outcomeText: string): ConsumerResult => ({ status: 'done', effectKind, effectRef, outcomeText });
const failed = (effectKind: string, effectRef: string, outcomeText: string): ConsumerResult => ({ status: 'failed', effectKind, effectRef, outcomeText });

export function makeConsumers(deps: SendDeps): ConsumerRegistry {
  const registry: Record<string, Consumer> = {};
  const hitl = { keyring: deps.keyring, clock: deps.clock, consumers: registry };

  /** Sends a draft with this input as the approval, or reports why it can't. */
  const sendWithApproval = async (ctx: ConsumerContext, draftId: string, owner?: { texts: string[]; ids: string[] }): Promise<ConsumerResult> => {
    const r = await sendDraft(deps, ctx.tx, draftId, { kind: 'approval', inputId: ctx.inputId, approverId: ctx.responderId }, owner);
    return r.status === 'queued' ? { status: 'pending' } : failed('draft.send', `draft:${draftId}`, refusalText(r.reason));
  };

  registry['draft.send'] = {
    ack: (r) => (r === 'approve' ? 'Approved. Sending your reply to the customer now.' : r === 'edit' ? 'Got your changes. Checking them before anything is sent.' : 'Rejected. Nothing will be sent to the customer.'),
    async apply(ctx) {
      const draftId = ref(ctx.question);
      if (ctx.response === 'approve') return sendWithApproval(ctx, draftId);
      if (ctx.response === 'reject') {
        await ctx.tx.updateTable('drafts').set({ status: 'rejected' }).where('id', '=', draftId).where('status', '=', 'pending_approval').execute();
        await releaseForDraft(deps, ctx.tx, draftId);
        await releaseInvoiceDraft(ctx.tx, draftId);
        return done('draft.rejected', `draft:${draftId}`, 'Done. Nothing was sent. The customer has their acknowledgement, and the enquiry stays open for you.');
      }
      // edit
      const text = ctx.detail?.trim();
      const parent = await loadDraft(deps, ctx.tx, draftId, true);
      if (!text) return failed('draft.edit', `draft:${draftId}`, 'No changed text arrived, so nothing was sent. Please try the edit again.');
      if (!parent || parent.row.status !== 'pending_approval') return failed('draft.edit', `draft:${draftId}`, refusalText('not_pending'));
      const child = await createDraft(deps, ctx.tx, {
        enquiryId: parent.row.enquiry_id, conversationId: parent.row.conversation_id, contactId: parent.row.contact_id, inReplyTo: parent.row.in_reply_to,
        channel: parent.row.channel, recipient: parent.recipient, purpose: parent.row.purpose, actionClass: parent.row.action_class, body: text,
        sources: parent.sources, generator: 'human', factsUsed: parent.row.facts_used, parentId: parent.row.id, draftVersion: parent.row.draft_version + 1,
      });
      await ctx.tx.updateTable('drafts').set({ status: 'superseded' }).where('id', '=', parent.row.id).execute();
      const snap = await snapshotAt(ctx.tx, deps.keyring, deps.clock.nowMs());
      const g = ground(text, parent.row.purpose, { factTexts: parent.sources.factTexts, factIds: parent.sources.factIds, customerText: parent.sources.customerText, ...(parent.sources.services ? { services: parent.sources.services } : {}) },
        { nowMs: deps.clock.nowMs(), timezone: snap.hours?.body.timezone ?? 'Europe/London' });
      if (g.ok) return sendWithApproval(ctx, child.id);
      // INV-16: the edit changed a fact. Ask, don't guess, whether it's a one-off or a records change (F25).
      const changes = g.failures.map((fl) => fl.detail);
      await ask(hitl, ctx.tx, {
        subjectContactId: parent.row.contact_id,
        kind: 'clarify_edit', subjectRef: `draft:${child.id}`, actionClass: parent.row.action_class, contentDigest: child.digest, requiredRole: 'approver', assignTo: ctx.responderId,
        body: {
          title: 'Quick check on your edit', summary: 'Your edit says something that isn\'t in your confirmed records. Is it just for this customer, or should your records change too?',
          preview: text, facts: changes, optionLabels: { one_off: 'Just for this customer', update_records: 'Also update my records', cancel: 'Don\'t send' },
          safeDefaultText: 'Nothing is sent until you choose.',
        },
        options: ['one_off', 'update_records', 'cancel'], safeDefault: 'hold', consumer: { kind: 'edit.clarify', ref: child.id }, deadlineMs: 72 * 3_600_000,
      });
      return done('draft.edit.clarification_asked', `draft:${child.id}`, 'Your edit changes a fact, so there is one quick question before it goes out. Nothing has been sent yet.');
    },
    async onReplyDue(tx, q) {
      await holdingUpdate(deps, tx, ref(q));
    },
    async onExpired(tx, q) {
      await tx.updateTable('drafts').set({ status: 'expired' }).where('id', '=', ref(q)).where('status', '=', 'pending_approval').execute();
      await releaseForDraft(deps, tx, ref(q));
      await releaseInvoiceDraft(tx, ref(q));
    },
  };

  registry['edit.clarify'] = {
    ack: (r) => (r === 'cancel' ? 'Understood. Nothing will be sent.' : r === 'one_off' ? 'Understood: just for this customer. Sending it now.' : 'Understood: sending it now, and your records will be updated once you confirm the change.'),
    async apply(ctx) {
      const draftId = ref(ctx.question);
      if (ctx.response === 'cancel') {
        await ctx.tx.updateTable('drafts').set({ status: 'rejected' }).where('id', '=', draftId).where('status', '=', 'pending_approval').execute();
        await releaseForDraft(deps, ctx.tx, draftId);
        await releaseInvoiceDraft(ctx.tx, draftId);
        return done('draft.rejected', `draft:${draftId}`, 'Done. Nothing was sent.');
      }
      const d = await loadDraft(deps, ctx.tx, draftId);
      if (!d) return failed('draft.send', `draft:${draftId}`, refusalText('not_pending'));
      if (ctx.response === 'update_records') {
        await ask(hitl, ctx.tx, {
          subjectContactId: d.row.contact_id,
          kind: 'knowledge_update', subjectRef: `draft:${draftId}`, contentDigest: d.row.content_digest, requiredRole: 'owner',
          body: { title: 'Update your records', summary: 'You changed a fact in a reply. Open your records and confirm the new value so future replies use it.', preview: d.body, optionLabels: { done: 'I have updated them', not_now: 'Not now' }, safeDefaultText: 'Your records stay as they are until you confirm a change.' },
          options: ['done', 'not_now'], safeDefault: 'hold', consumer: { kind: 'knowledge.update', ref: draftId }, deadlineMs: 14 * 86_400_000,
        });
      }
      // The human's own words are the authority for this one message (cited by this input).
      return sendWithApproval(ctx, draftId, { texts: [d.body], ids: [`owner_edit:${ctx.inputId}`] });
    },
    async onExpired(tx, q) {
      await tx.updateTable('drafts').set({ status: 'expired' }).where('id', '=', ref(q)).where('status', '=', 'pending_approval').execute();
      await releaseForDraft(deps, tx, ref(q));
      await releaseInvoiceDraft(tx, ref(q));
    },
  };

  registry['owner.task'] = {
    ack: (r) => (r === 'reply' ? 'Got your reply. Checking it and sending it to the customer.' : 'Marked as dealt with. Nothing more will be sent.'),
    async apply(ctx) {
      const enquiryId = ref(ctx.question);
      if (ctx.response === 'handled') return done('enquiry.handled', `enquiry:${enquiryId}`, 'Recorded as dealt with by you.');
      const text = ctx.detail?.trim();
      if (!text) return failed('owner.reply', `enquiry:${enquiryId}`, 'No reply text arrived, so nothing was sent. Please try again.');
      const e = await ctx.tx.selectFrom('enquiries').select(['message_id']).where('id', '=', enquiryId).executeTakeFirst();
      if (!e) return failed('owner.reply', `enquiry:${enquiryId}`, 'That enquiry no longer exists.');
      const c = await customerOf(deps, ctx.tx, e.message_id);
      if (!c.channel || !c.recipient) return failed('owner.reply', `enquiry:${enquiryId}`, 'There is no email or mobile number to reply to, so nothing was sent. Please contact the customer directly.');
      const draft = await createDraft(deps, ctx.tx, {
        enquiryId, conversationId: c.conversationId, contactId: c.contactId, inReplyTo: c.messageId, channel: c.channel, recipient: c.recipient,
        purpose: 'reply', actionClass: 'info_reply', body: text, sources: { factTexts: [], factIds: [], customerText: c.text }, generator: 'human', factsUsed: [],
      });
      return sendWithApproval(ctx, draft.id, { texts: [text], ids: [`owner_reply:${ctx.inputId}`] });
    },
  };

  registry['knowledge.update'] = {
    ack: (r) => (r === 'done' ? 'Thanks. Future replies will use your confirmed records.' : 'Okay. Your records stay as they are.'),
    async apply(ctx) {
      return done('knowledge.update.acknowledged', `draft:${ref(ctx.question)}`, ctx.response === 'done' ? 'Noted.' : 'Noted. You can update your records any time.');
    },
  };

  registry['autonomy.grant'] = {
    ack: (r) => (r === 'grant' ? 'Understood. Checking the record before switching this on.' : 'Understood. Every message of this kind will keep coming to you first.'),
    async apply(ctx) {
      const cls = ref(ctx.question);
      if (ctx.response !== 'grant') return done('autonomy.declined', `class:${cls}`, 'Nothing changed: you approve these yourself.');
      try {
        const id = await grantAutonomy(ctx.tx, { actionClass: cls, inputId: ctx.inputId, grantedBy: ctx.responderId });
        return done('autonomy.granted', `grant:${id}`, 'Switched on. Messages of this kind now send without asking. Any problem switches this off automatically.');
      } catch (err) {
        return failed('autonomy.granted', `class:${cls}`, `Not switched on: ${(err as Error).message.replace(/^[^:]+: /, '')}.`);
      }
    },
  };

  registry['dsar.release'] = {
    ack: (r) => ({
      release: 'Understood. Preparing their copy and sending them a secure link.',
      erase: 'Understood. Sending them a confirmation, then deleting their information.',
      done: 'Recorded as dealt with.',
      refuse: 'Recorded as refused.',
    } as Record<string, string>)[r] ?? 'Recorded.',
    async apply(ctx) {
      const dsarId = ref(ctx.question);
      const d = await ctx.tx.selectFrom('dsar_requests').selectAll().where('id', '=', dsarId).forUpdate().executeTakeFirst();
      if (!d || d.status !== 'awaiting_release') return failed('dsar', `dsar:${dsarId}`, 'This request has already been dealt with.');
      const setStatus = (status: 'releasing' | 'completed' | 'refused', outcome: string) =>
        ctx.tx.updateTable('dsar_requests').set({ status, outcome, ...(status !== 'releasing' ? { completed_at: deps.clock.now() } : {}) }).where('id', '=', dsarId).execute();
      if (ctx.response === 'refuse') {
        await setStatus('refused', 'refused_by_owner');
        return done('dsar.refused', `dsar:${dsarId}`, `Recorded as refused. You must tell them why, and that they can complain to the Information Commissioner's Office, by ${d.due_at.toISOString().slice(0, 10)}.`);
      }
      if (ctx.response === 'done') {
        await setStatus('completed', 'handled_by_owner');
        return done('dsar.completed', `dsar:${dsarId}`, 'Recorded as dealt with by you.');
      }
      if (!d.contact_id || !d.source_message_id) return failed('dsar', `dsar:${dsarId}`, 'This person\'s details are no longer held, so there is nothing more to do.');
      const snap = await snapshotAt(ctx.tx, deps.keyring, deps.clock.nowMs());
      const b = snap.business?.body;
      if (!b) return failed('dsar', `dsar:${dsarId}`, 'Your business details are missing, so nothing was sent. Please complete them first.');
      const c = await customerOf(deps, ctx.tx, d.source_message_id);
      const base = (deps.publicBaseUrl ?? 'https://localhost.invalid').replace(/\/$/, '');
      const values = { business: b.trading_name, replyTime: b.reply_time_statement, privacyUrl: b.privacy_notice_url, discloseAutomation: true };
      const sendToThem = async (templateId: 'dsar_ready' | 'erasure_done', link: string | undefined, receiptByDispatch: boolean): Promise<{ outboxId: string } | { problem: string }> => {
        if (!c.channel || !c.recipient) return { problem: 'there is no email or mobile number to send it to' };
        const r = render(templateId, c.channel, { ...values, ...(link ? { link } : {}) });
        if (!r.ok) return { problem: `the message could not be written (${r.reason})` };
        // The link and its fixed lifetime are facts of this message (grounding checks every number, §68).
        const fixed = link ? [link, `The link works once, for ${Math.round(DOWNLOAD_TTL_MS / 86_400_000)} days.`] : [];
        const draft = await createDraft(deps, ctx.tx, {
          enquiryId: null, conversationId: c.conversationId, contactId: c.contactId, inReplyTo: c.messageId, channel: c.channel, recipient: c.recipient,
          purpose: 'reply', actionClass: 'info_reply', body: r.text, sources: { factTexts: [b.trading_name, b.privacy_notice_url, ...fixed], factIds: [], customerText: '' },
          generator: 'template', templateId, factsUsed: [],
        });
        const sent = await sendDraft(deps, ctx.tx, draft.id, { kind: 'approval', inputId: ctx.inputId, approverId: ctx.responderId }, undefined, { receiptByDispatch });
        return sent.status === 'queued' ? { outboxId: sent.outboxId } : { problem: refusalText(sent.reason).replace(/\.$/, '').toLowerCase() };
      };
      if (ctx.response === 'release') {
        const copy = await assembleCopy(deps, ctx.tx, d.contact_id, b.trading_name, b.privacy_notice_url);
        const token = await prepareDownload(deps, ctx.tx, dsarId, d.contact_id, copy);
        const sent = await sendToThem('dsar_ready', `${base}/v1/dsar/${token}`, true);
        await setStatus('completed', 'outboxId' in sent ? 'copy_sent' : 'copy_ready_not_sent');
        return 'outboxId' in sent ? { status: 'pending' } : failed('dsar.copy', `dsar:${dsarId}`, `Their copy is ready, but the link was not sent: ${sent.problem}. Please contact them directly.`);
      }
      // erase: confirm to them first, then erase once that message has gone (or failed for good).
      const sent = await sendToThem('erasure_done', undefined, false);
      await setStatus('releasing', 'erasing');
      await enqueue(ctx.tx, { kind: DSAR_ERASE_JOB, dedupeKey: `erase:${dsarId}`, payload: { dsar_id: dsarId, contact_id: d.contact_id, input_id: ctx.inputId, outbox_id: 'outboxId' in sent ? sent.outboxId : null } });
      return { status: 'pending' };
    },
    async onReplyDue(tx, q) {
      const owner = await tx.selectFrom('users').select('id').where('role', '=', 'owner').where('status', '=', 'active').executeTakeFirst();
      if (owner) await notify(tx, deps.keyring, { userId: owner.id, kind: 'alert', ref: `question:${q.id}`, dedupeKey: `dsar_due_soon:${q.id}`, text: 'A customer\'s personal-information request is due in 7 days. Please decide what to do.' });
    },
  };

  return registry;
}

/**
 * §74.4: the approval is still open at the customer's promised reply time. One deterministic holding
 * update (ack class, fixed wording, no commitments). Exactly once per enquiry (outbox dedupe key, F53).
 */
export async function holdingUpdate(deps: SendDeps, tx: TenantTx, draftId: string): Promise<'sent' | 'off' | 'skipped'> {
  const tenant = await tx.selectFrom('tenants').select(['holding_update_enabled']).where('id', '=', tx.scope.tenantId).executeTakeFirstOrThrow();
  if (!tenant.holding_update_enabled) return 'off';
  const d = await loadDraft(deps, tx, draftId);
  if (!d || d.row.status !== 'pending_approval') return 'skipped';
  const snap = await snapshotAt(tx, deps.keyring, deps.clock.nowMs());
  const b = snap.business;
  if (!b) return 'skipped';
  const r = render('holding_update', d.row.channel, { business: b.body.trading_name, replyTime: b.body.reply_time_statement, privacyUrl: b.body.privacy_notice_url, discloseAutomation: true });
  if (!r.ok) return 'skipped';
  const g = ground(r.text, 'holding', { factTexts: [b.body.trading_name], factIds: [`${b.id}@${b.version}`], customerText: '' }, { nowMs: deps.clock.nowMs(), timezone: snap.hours?.body.timezone ?? 'Europe/London' });
  if (!g.ok) return 'skipped';
  const key = `${d.row.enquiry_id ?? d.row.id}:holding_update`;
  const res = await reserve(tx, deps.keyring, deps.clock, {
    draft: g.draft, conversationId: d.row.conversation_id, contactId: d.row.contact_id, ...(d.row.in_reply_to ? { inReplyTo: d.row.in_reply_to } : {}),
    channel: d.row.channel, recipient: d.recipient, actionClass: 'ack', dedupeKey: key, templateId: 'holding_update', templateVersion: r.version,
  });
  if (res.status === 'reserved' && res.created) await enqueue(tx, { kind: OUTBOX_DISPATCH_JOB, dedupeKey: `dispatch:${res.outboxId}`, ...(res.notBefore ? { runAt: res.notBefore } : {}), payload: { outbox_id: res.outboxId } });
  return res.status === 'reserved' && res.created ? 'sent' : 'skipped';
}
