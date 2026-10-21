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
import { factsBundle, matchOfferChoice, replySections, slotPhrase, type ActionClass, type EnquiryAnalysis } from '@sevari/domain';
import { ground } from '@sevari/grounding';
import { ask, digestOf, type ConsumerRegistry } from '@sevari/hitl';
import { classifyRightsRequest, openDsar } from '@sevari/privacy';
import { scheduleWeeklyReport } from '@sevari/metrics';
import { snapshotAt } from '@sevari/knowledge';
import { recordReply } from '@sevari/outbound';
import { render } from '@sevari/templates';
import { holdSlot, liveOffer, recordOffer } from './bookings.ts';
import type { Lifecycles } from './journey.ts';
import { createDraft, sendDraft } from './sending.ts';

export interface RespondDeps {
  readonly keyring: TenantKeyring;
  readonly clock: Clock;
  readonly consumers: ConsumerRegistry;
  readonly lifecycles?: Lifecycles;
}

/** How long a reply waits for approval before closing to its safe default (nothing sent). */
export const APPROVAL_DEADLINE_MS = 72 * 3_600_000;

export function actionClassFor(a: EnquiryAnalysis): ActionClass {
  if (a.intent.intent === 'cancel' && a.booking) return 'cancel';
  return a.intent.intent === 'quote_request' ? 'quote_reply' : 'info_reply';
}

const orList = (xs: readonly string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}` : xs[0] ?? '');

export async function respond(deps: RespondDeps, tx: TenantTx, enquiryId: string): Promise<{ outcome: string }> {
  const e = await tx.selectFrom('enquiries').selectAll().where('id', '=', enquiryId).executeTakeFirst();
  if (!e) return { outcome: 'not_found' };
  const already = await tx.selectFrom('drafts').select('id').where('enquiry_id', '=', enquiryId).executeTakeFirst()
    ?? await tx.selectFrom('human_questions').select('id').where('subject_ref', '=', `enquiry:${enquiryId}`).executeTakeFirst();
  if (already) return { outcome: 'already' };
  await scheduleWeeklyReport(tx, deps.clock.nowMs());
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
  const tz = snap.hours?.body.timezone ?? 'Europe/London';
  const values0 = business ? { business: business.trading_name, replyTime: business.reply_time_statement, privacyUrl: business.privacy_notice_url, discloseAutomation: false } : null;
  const businessFact = snap.business ? [`${snap.business.id}@${snap.business.version}`] : [];

  /** A booking message: grounded against exactly the slot it states, then approved like any reply (§24). */
  const bookingDraft = async (o: { actionClass: ActionClass; templateId: 'booking_confirm' | 'booking_moved' | 'booking_cancelled' | 'clarify'; slot?: string; question?: string; factTexts: string[]; factIds: string[]; title: string; summary: string; purpose: 'reply' | 'clarify' }) => {
    if (!values0 || !business || !c.channel || !c.recipient) return null;
    const rendered = render(o.templateId, c.channel, { ...values0, ...(o.slot ? { slot: o.slot } : {}), ...(o.question ? { question: o.question } : {}) });
    const sources = { factTexts: [...o.factTexts, business.trading_name], factIds: o.factIds, customerText: c.text };
    const g = rendered.ok ? ground(rendered.text, o.purpose, sources, { nowMs: deps.clock.nowMs(), timezone: tz }) : null;
    if (!rendered.ok || !g?.ok) return null;
    const draft = await createDraft(deps, tx, {
      enquiryId, conversationId: c.conversationId, contactId: c.contactId, inReplyTo: e.message_id, channel: c.channel, recipient: c.recipient,
      purpose: o.purpose, actionClass: o.actionClass, body: g.draft.text, sources, generator: 'template', templateId: rendered.templateId, factsUsed: o.factIds,
    });
    return { ...o, draft, channel: c.channel, text: g.draft.text, templateId: rendered.templateId };
  };
  const putForApproval = async (d: NonNullable<Awaited<ReturnType<typeof bookingDraft>>>) => {
    const decision = await decide(tx, d.actionClass);
    if (decision.mode === 'granted') {
      const r = await sendDraft(deps, tx, d.draft.id, { kind: 'grant', grantId: decision.grantId });
      if (r.status === 'queued') return 'sent_under_grant';
    }
    await ask({ ...deps }, tx, {
      subjectContactId: c.contactId, kind: 'approve_draft', subjectRef: `draft:${d.draft.id}`, actionClass: d.actionClass, contentDigest: d.draft.digest, requiredRole: 'approver',
      body: { title: d.title, summary: d.summary, preview: d.text, facts: d.factTexts, optionLabels: { approve: 'Send it', edit: 'Change it', reject: 'Don\'t send' }, safeDefaultText: 'Nothing is sent or booked until someone approves it.' },
      options: ['approve', 'edit', 'reject'], safeDefault: 'hold', consumer: { kind: 'draft.send', ref: d.draft.id }, deadlineMs: APPROVAL_DEADLINE_MS, replyDueAt,
    });
    await recordReply(tx, { inboundMessageId: e.message_id, enquiryId, purpose: d.purpose, channel: d.channel, intent: a.intent.intent, intentConfidence: a.intent.confidence, generator: 'template', templateId: d.templateId, factsUsed: d.factIds, factsMissing: [], groundingOk: true, autonomyDecision: decision.mode === 'approval' ? `approval:${decision.reason}` : 'approval:grant_refused', sendResult: 'awaiting_approval', latencyMs: {} });
    return 'awaiting_approval';
  };

  // A reply choosing one of the times this customer was offered (§16.1 stage 4): hold it, confirm on approval.
  if (values0 && c.channel && c.recipient && (e.route === 'answer' || e.route === 'clarify' || e.route === 'unknown')) {
    const offer = await liveOffer(tx, c.conversationId, deps.clock.nowMs());
    const choice = offer ? matchOfferChoice(c.text, offer.windows, { nowMs: deps.clock.nowMs(), timezone: tz }) : null;
    if (offer && choice?.kind === 'one') {
      const w = offer.windows[choice.index];
      if (!w) throw new Error('offer choice out of range');
      const slot = slotPhrase(w);
      const bookingId = await holdSlot(tx, {
        contactId: c.contactId, conversationId: c.conversationId, enquiryId, offerId: offer.id, service: offer.service,
        slot: w, holdUntilMs: deps.clock.nowMs() + APPROVAL_DEADLINE_MS, replacesId: offer.reschedule_of,
      });
      if (!bookingId) {
        await ownerTask('The time this customer chose has just been taken', `They chose ${slot}, but that time is no longer free. Nothing has been sent to them yet.`, [`Chosen: ${slot}`]);
        return { outcome: 'owner_task_slot_taken' };
      }
      await tx.updateTable('booking_offers').set({ status: 'taken' }).where('id', '=', offer.id).execute();
      const moved = offer.reschedule_of !== null;
      const d = await bookingDraft({
        actionClass: moved ? 'booking_change' : 'booking_create', templateId: moved ? 'booking_moved' : 'booking_confirm', slot, purpose: 'reply',
        factTexts: [moved ? `You are now booked in for ${slot}.` : `You are booked in for ${slot}.`], factIds: [`offer:${offer.id}`, ...businessFact],
        title: moved ? 'Booking change ready to confirm' : 'Booking ready to confirm',
        summary: `The customer chose ${slot} from the times you offered. That time is held for them until you decide. Approving sends this confirmation and makes the booking.`,
      });
      if (!d) {
        await tx.updateTable('bookings').set({ status: 'released', closed_at: deps.clock.now(), hold_expires_at: null }).where('id', '=', bookingId).execute();
        await tx.updateTable('booking_offers').set({ status: 'sent' }).where('id', '=', offer.id).execute();
        await ownerTask('Sevari couldn\'t write a safe booking confirmation', `The customer chose ${slot}. Nothing was sent or booked.`);
        return { outcome: 'owner_task_blocked' };
      }
      await tx.updateTable('bookings').set({ draft_id: d.draft.id }).where('id', '=', bookingId).execute();
      return { outcome: `booking_${await putForApproval(d)}` };
    }
    if (offer && choice?.kind === 'ambiguous') {
      const slots = offer.windows.filter((_, i) => choice.candidates.includes(i)).map(slotPhrase);
      const d = await bookingDraft({
        actionClass: 'info_reply', templateId: 'clarify', question: `Which time would suit you best: ${orList(slots)}?`, purpose: 'clarify',
        factTexts: slots.map((x) => `Available: ${x}.`), factIds: [`offer:${offer.id}`, ...businessFact],
        title: 'Question for the customer, ready to approve', summary: 'Their reply could mean more than one of the times you offered, so Sevari asks which one. Nothing is booked yet.',
      });
      if (d) return { outcome: `which_time_${await putForApproval(d)}` };
    }
  }

  // A request to cancel an existing booking: the confirmation is always approved by a person (§7.2).
  if (e.route === 'answer' && a.intent.intent === 'cancel' && a.booking) {
    const slot = slotPhrase(a.booking);
    const d = await bookingDraft({
      actionClass: 'cancel', templateId: 'booking_cancelled', slot, purpose: 'reply', factTexts: [`Your booking is for ${slot}.`], factIds: [`booking:${a.booking.id}`, ...businessFact],
      title: 'A customer wants to cancel their booking', summary: `Their booking is for ${slot}. Approving sends this message and cancels the booking, freeing the time.`,
    });
    if (!d) {
      await ownerTask('A customer wants to cancel', `Their booking is for ${slot}. Sevari couldn't write a safe reply, so nothing was sent or cancelled.`);
      return { outcome: 'owner_task_blocked' };
    }
    await tx.updateTable('bookings').set({ cancel_draft_id: d.draft.id }).where('id', '=', a.booking.id).execute();
    return { outcome: `cancel_${await putForApproval(d)}` };
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
  // Times offered in this reply become choosable once it is sent (only these can be booked).
  if (e.route === 'answer' && a.windows?.length) {
    await recordOffer(tx, {
      contactId: c.contactId, conversationId: c.conversationId, enquiryId, draftId: draft.id, service: a.services[0] ?? null, windows: a.windows,
      rescheduleOf: a.intent.intent === 'reschedule' && a.booking ? a.booking.id : null, nowMs: deps.clock.nowMs(),
    });
  }
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
