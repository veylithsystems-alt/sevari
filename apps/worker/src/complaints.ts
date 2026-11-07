/**
 * Complaints and disputes (§20). A complaint opens a case with an owner, a clock and a case file:
 *   always-human (legal threat, regulator, safeguarding, discrimination, injury or damage, media,
 *     vulnerable customer): the customer has only the holding acknowledgement; the owner gets the case.
 *   standard: the owner chooses a remedy from their own resolution policy (§20.3), writes the reply
 *     themselves, or marks it resolved. A remedy outside the policy is refused (T-CMP-2); the model
 *     never invents compensation, and every remedy message is fact-checked against the policy.
 *   clock: if the case isn't resolved by the promised time, the owner is alerted (T-CMP-3).
 *   closure: a root cause is recorded; the customer's journey leaves "complaint open".
 */
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { enqueue, sql, type TenantTx } from '@sevari/db';
import type { SensitiveFlag } from '@sevari/domain';
import { formatMoney } from '@sevari/finance';
import { ground } from '@sevari/grounding';
import { ask, digestOf, notify, ownerOf, type Consumer, type ConsumerRegistry } from '@sevari/hitl';
import { snapshotAt } from '@sevari/knowledge';
import { render } from '@sevari/templates';
import { journeyEvent, type Lifecycles } from './journey.ts';
import { customerOf } from './respond.ts';
import { createDraft, refusalText, sendDraft } from './sending.ts';

export const COMPLAINT_CLOCK_JOB = 'complaint.clock';
const ALWAYS_HUMAN: readonly SensitiveFlag[] = ['legal_threat', 'regulator', 'safeguarding', 'discrimination', 'injury_or_damage', 'media', 'vulnerable_customer'];
const DEFAULT_RESPONSE_DAYS = 7;

export interface ComplaintDeps { readonly keyring: TenantKeyring; readonly clock: Clock; readonly consumers: ConsumerRegistry; readonly lifecycles?: Lifecycles }

const REMEDY_TEXT: Record<string, string> = { apology: 'an apology', redo: 'to come back and put the work right at no charge', partial_credit: 'a credit of', refund: 'a refund of' };

export async function openComplaint(deps: ComplaintDeps, tx: TenantTx, c: { enquiryId: string; contactId: string; conversationId: string; messageId: string; flags: readonly SensitiveFlag[]; text: string }): Promise<string> {
  const existing = await tx.selectFrom('complaint_cases').select('id').where('conversation_id', '=', c.conversationId).where('status', 'in', ['open', 'remedy_proposed']).executeTakeFirst();
  if (existing) return existing.id;
  const reasons = c.flags.filter((f) => ALWAYS_HUMAN.includes(f));
  const category = reasons.length ? 'always_human' as const : 'standard' as const;
  if (c.flags.includes('vulnerable_customer')) await tx.updateTable('contacts').set({ vulnerable_flag: true }).where('id', '=', c.contactId).execute();
  const snap = await snapshotAt(tx, deps.keyring, deps.clock.nowMs());
  const policy = snap.resolution?.body;
  const now = deps.clock.nowMs();
  const respondBy = new Date(now + (policy?.response_days ?? DEFAULT_RESPONSE_DAYS) * 86_400_000);
  const owner = await ownerOf(tx);
  const row = await tx.insertInto('complaint_cases').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, contact_id: c.contactId, enquiry_id: c.enquiryId, conversation_id: c.conversationId,
    category, reasons, assigned_user_id: owner, opened_at: new Date(now), respond_by: respondBy,
  }).returning('id').executeTakeFirstOrThrow();
  // The case file: what Sevari already knows, gathered for the owner (§20.3 "gather facts").
  const bookings = await tx.selectFrom('bookings').select(['status', 'starts_at']).where('contact_id', '=', c.contactId).orderBy('starts_at', 'desc').limit(5).execute();
  const invoices = await tx.selectFrom('invoices').select(['number', 'total_minor', 'currency', 'status']).where('contact_id', '=', c.contactId).where('status', '<>', 'void').execute();
  const messages = Number((await tx.selectFrom('messages').select(sql<string>`count(*)`.as('n')).where('conversation_id', '=', c.conversationId).executeTakeFirstOrThrow()).n);
  const facts = [
    `Respond by ${respondBy.toISOString().slice(0, 10)} (${policy?.response_days ?? DEFAULT_RESPONSE_DAYS} days${policy ? ', your policy' : ', default'})`,
    ...reasons.map((r) => `Needs you personally: ${r.replace(/_/g, ' ')}`),
    ...bookings.map((b) => `Booking ${b.starts_at.toISOString().slice(0, 10)}: ${b.status}`),
    ...invoices.map((i) => `Invoice ${i.number ?? '(draft)'}: ${formatMoney(Number(i.total_minor), i.currency)}, ${i.status}`),
    `${messages} message(s) in this conversation`,
  ];
  const remedies = category === 'standard' && policy ? policy.remedies.map((m) => `remedy:${m.type}`) : [];
  const options = [...remedies, 'reply_myself', 'resolved'];
  const labels: Record<string, string> = { reply_myself: 'I\'ll write the reply', resolved: 'It\'s resolved' };
  for (const m of policy?.remedies ?? []) labels[`remedy:${m.type}`] = `Offer ${REMEDY_TEXT[m.type]}${m.max_minor ? ` (up to ${formatMoney(m.max_minor)})` : ''}`;
  await ask({ keyring: deps.keyring, clock: deps.clock, consumers: deps.consumers }, tx, {
    subjectContactId: c.contactId, kind: 'complaint', subjectRef: `complaint:${row.id}`, contentDigest: digestOf({ case: row.id }), requiredRole: 'owner', ...(owner ? { assignTo: owner } : {}),
    body: {
      title: category === 'always_human' ? 'A complaint that needs you personally' : 'A customer has complained',
      summary: category === 'always_human'
        ? 'This complaint mentions something Sevari never handles by itself. The customer has had a holding reply only. Please deal with it personally.'
        : `The customer has had a holding reply. Choose a remedy from your resolution policy, write the reply yourself, or mark it resolved.${policy ? '' : ' You have no resolution policy yet, so Sevari can\'t offer remedies for you.'}`,
      preview: c.text, facts, optionLabels: Object.fromEntries(options.map((o) => [o, labels[o] ?? o])), safeDefaultText: 'Nothing is sent to the customer until you decide.',
    },
    options, safeDefault: 'escalate', consumer: { kind: 'complaint.decide', ref: row.id }, deadlineMs: Math.max(60_000, respondBy.getTime() - now),
  });
  await enqueue(tx, { kind: COMPLAINT_CLOCK_JOB, dedupeKey: `complaint-clock:${row.id}`, runAt: respondBy, payload: { case_id: row.id } });
  await appendAudit(tx, { type: 'complaint.opened', actor: { kind: 'system' }, subject: `complaint:${row.id}`, payload: { category, reasons, respond_by: respondBy.toISOString() } });
  return row.id;
}

/** The complaint clock (T-CMP-3): unresolved at the promised time means a breach alert to the owner. */
export async function complaintClock(deps: ComplaintDeps, tx: TenantTx, caseId: string): Promise<string> {
  const k = await tx.selectFrom('complaint_cases').select(['status', 'respond_by', 'assigned_user_id', 'breached_at']).where('id', '=', caseId).executeTakeFirst();
  if (!k || k.status === 'resolved' || k.status === 'closed') return 'resolved_in_time';
  if (deps.clock.nowMs() < k.respond_by.getTime()) throw new Error('complaint clock not due yet');
  if (k.breached_at) return 'already_breached';
  await tx.updateTable('complaint_cases').set({ breached_at: deps.clock.now() }).where('id', '=', caseId).execute();
  const to = k.assigned_user_id ?? (await ownerOf(tx));
  if (to) await notify(tx, deps.keyring, { userId: to, kind: 'alert', ref: `complaint:${caseId}`, dedupeKey: `complaint-breach:${caseId}`, text: `Overdue: a complaint was due a full response by ${k.respond_by.toISOString().slice(0, 10)} and isn't resolved yet. Please deal with it today.` });
  await appendAudit(tx, { type: 'complaint.breached', actor: { kind: 'system' }, subject: `complaint:${caseId}`, payload: { respond_by: k.respond_by.toISOString() } });
  return 'breached';
}

export function complaintConsumers(deps: ComplaintDeps): Record<string, Consumer> {
  const failed = (ref: string, text: string) => ({ status: 'failed' as const, effectKind: 'complaint', effectRef: ref, outcomeText: text });
  return {
    'complaint.decide': {
      ack: (r) => (r === 'resolved' ? 'Marked as resolved.' : r === 'reply_myself' ? 'Got your reply. Checking it before it goes.' : 'Got it. Checking that against your policy now.'),
      async apply(ctx) {
        const caseId = ctx.question.consumer_ref;
        const ref = `complaint:${caseId}`;
        const k = await ctx.tx.selectFrom('complaint_cases').selectAll().where('id', '=', caseId).forUpdate().executeTakeFirst();
        if (!k || !k.contact_id || !k.conversation_id) return failed(ref, 'That complaint record is no longer available.');
        if (ctx.response === 'resolved') {
          await ctx.tx.updateTable('complaint_cases').set({ status: 'resolved', resolved_at: deps.clock.now() }).where('id', '=', caseId).execute();
          await ask({ keyring: deps.keyring, clock: deps.clock, consumers: deps.consumers }, ctx.tx, {
            subjectContactId: k.contact_id, kind: 'complaint', subjectRef: `complaint-close:${caseId}`, contentDigest: digestOf({ close: caseId }), requiredRole: 'owner',
            body: { title: 'What was the main cause?', summary: 'One tap closes the case and helps you spot patterns. Nothing is sent to the customer.', optionLabels: { workmanship: 'The work itself', communication: 'Communication', price: 'Price', timing: 'Timing', damage: 'Damage', no_fault: 'No fault found', other: 'Something else' }, safeDefaultText: 'The case stays resolved but not closed until you choose.' },
            options: ['workmanship', 'communication', 'price', 'timing', 'damage', 'no_fault', 'other'], safeDefault: 'hold', consumer: { kind: 'complaint.close', ref: caseId }, deadlineMs: 30 * 86_400_000,
          });
          await journeyEvent(deps, ctx.tx, k.contact_id, { event: 'complaint_resolved', idempotencyKey: `complaint:${caseId}`, actor: `user:${ctx.responderId}`, authority: { kind: 'human', inputId: ctx.inputId } });
          await appendAudit(ctx.tx, { type: 'complaint.resolved', actor: { kind: 'user', ref: ctx.responderId }, subject: ref, payload: { breached: k.breached_at !== null } });
          return { status: 'done', effectKind: 'complaint.resolved', effectRef: ref, outcomeText: 'Recorded as resolved.' };
        }
        const msg = await ctx.tx.selectFrom('messages').select('id').where('conversation_id', '=', k.conversation_id).where('direction', '=', 'inbound').orderBy('received_at', 'desc').executeTakeFirstOrThrow();
        const c = await customerOf(deps, ctx.tx, msg.id);
        if (!c.channel || !c.recipient) return failed(ref, 'There is no email or mobile number for this customer, so nothing was sent. Please contact them directly.');
        const send = async (body: string, actionClass: string, facts: string[], factIds: string[], templateId?: string) => {
          const d = await createDraft(deps, ctx.tx, { enquiryId: k.enquiry_id, conversationId: k.conversation_id as string, contactId: k.contact_id as string, inReplyTo: c.messageId, channel: c.channel as 'email' | 'sms', recipient: c.recipient as string,
            purpose: 'reply', actionClass, body, sources: { factTexts: facts, factIds, customerText: c.text }, generator: templateId ? 'template' : 'human', ...(templateId ? { templateId } : {}), factsUsed: factIds });
          const r = await sendDraft(deps, ctx.tx, d.id, { kind: 'approval', inputId: ctx.inputId, approverId: ctx.responderId }, { texts: facts, ids: factIds });
          return r.status === 'queued' ? null : refusalText(r.reason);
        };
        if (ctx.response === 'reply_myself') {
          const text = ctx.detail?.trim();
          if (!text) return failed(ref, 'No reply text arrived, so nothing was sent.');
          const err = await send(text, 'info_reply', [text], [`owner_reply:${ctx.inputId}`]);
          return err ? failed(ref, err) : { status: 'pending' };
        }
        if (k.category === 'always_human') return failed(ref, 'This complaint needs your own reply; Sevari doesn\'t offer remedies for it.');
        // A remedy: only from the owner's confirmed resolution policy, within its limits (§20.3, T-CMP-2).
        const type = ctx.response.replace(/^remedy:/, '');
        const snap = await snapshotAt(ctx.tx, deps.keyring, deps.clock.nowMs());
        const policy = snap.resolution;
        const rule = policy?.body.remedies.find((m) => m.type === type);
        if (!policy || !rule) return failed(ref, 'That remedy isn\'t in your resolution policy, so nothing was offered. Write the reply yourself if you want to offer it.');
        let amount: number | null = null;
        if (rule.max_minor !== undefined) {
          const m = /^\s*£?\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(ctx.detail ?? '');
          if (!m) return failed(ref, `Please give the amount to offer (up to ${formatMoney(rule.max_minor)}).`);
          amount = Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
          if (amount > rule.max_minor) {
            await appendAudit(ctx.tx, { type: 'complaint.remedy_refused', actor: { kind: 'user', ref: ctx.responderId }, subject: ref, payload: { type, amount_minor: amount, limit_minor: rule.max_minor } });
            return failed(ref, `Not offered: ${formatMoney(amount)} is above your policy's limit of ${formatMoney(rule.max_minor)}. To offer more, write the reply yourself (it will still need your approval).`);
          }
        }
        const offer = `${REMEDY_TEXT[type]}${amount !== null ? ` ${formatMoney(amount)}` : ''}`;
        const business = snap.business?.body;
        if (!business) return failed(ref, 'Your business details are missing, so nothing was sent.');
        const r = render('complaint_remedy', c.channel, { business: business.trading_name, replyTime: business.reply_time_statement, privacyUrl: business.privacy_notice_url, discloseAutomation: false, remedy: { offer, conditions: rule.conditions } });
        if (!r.ok) return failed(ref, `The remedy message couldn't be written (${r.reason}).`);
        const facts = [`We would like to offer ${offer}.`, rule.conditions, business.trading_name];
        const g = ground(r.text, 'reply', { factTexts: facts, factIds: [`${policy.id}@${policy.version}`], customerText: c.text }, { nowMs: deps.clock.nowMs(), timezone: snap.hours?.body.timezone ?? 'Europe/London' });
        if (!g.ok) return failed(ref, `The remedy message didn't pass the fact check: ${g.failures.map((f) => f.detail).join('; ')}`);
        await ctx.tx.updateTable('complaint_cases').set({ status: 'remedy_proposed', remedy: JSON.stringify({ type, amount_minor: amount }) }).where('id', '=', caseId).execute();
        // An approval covers only the exact words a person saw (§7.1), so the remedy message is shown for approval.
        const actionClass = amount !== null ? 'refund' : 'info_reply';
        const d = await createDraft(deps, ctx.tx, { enquiryId: k.enquiry_id, conversationId: k.conversation_id, contactId: k.contact_id, inReplyTo: c.messageId, channel: c.channel, recipient: c.recipient,
          purpose: 'reply', actionClass, body: g.draft.text, sources: { factTexts: facts, factIds: [`${policy.id}@${policy.version}`], customerText: c.text }, generator: 'template', templateId: 'complaint_remedy', factsUsed: [`${policy.id}@${policy.version}`] });
        await ask({ keyring: deps.keyring, clock: deps.clock, consumers: deps.consumers }, ctx.tx, {
          subjectContactId: k.contact_id, kind: 'approve_draft', subjectRef: `draft:${d.id}`, actionClass, contentDigest: d.digest, requiredRole: 'owner',
          body: { title: 'Remedy ready to send', summary: `Offering ${offer}, within your resolution policy.`, preview: g.draft.text, facts, optionLabels: { approve: 'Send it', edit: 'Change it', reject: 'Don\'t send' }, safeDefaultText: 'Nothing is offered until you approve.' },
          options: ['approve', 'edit', 'reject'], safeDefault: 'hold', consumer: { kind: 'draft.send', ref: d.id }, deadlineMs: Math.max(60_000, k.respond_by.getTime() - deps.clock.nowMs()),
        });
        return { status: 'done', effectKind: 'complaint.remedy_drafted', effectRef: ref, outcomeText: `Within your policy. The message offering ${offer} is ready for you to approve.` };
      },
    },
    'complaint.close': {
      ack: () => 'Thanks. Closing the case.',
      async apply(ctx) {
        const caseId = ctx.question.consumer_ref;
        await ctx.tx.updateTable('complaint_cases').set({ status: 'closed', root_cause: ctx.response as 'other' }).where('id', '=', caseId).where('status', '=', 'resolved').execute();
        return { status: 'done', effectKind: 'complaint.closed', effectRef: `complaint:${caseId}`, outcomeText: 'Closed.' };
      },
    },
  };
}

/**
 * A dispute or chargeback evidence pack (§20.4), assembled from the ledger, the audit log and the
 * conversation, for the owner to check and submit themselves. Sevari never submits it.
 */
export async function disputeEvidencePack(deps: { keyring: TenantKeyring }, tx: TenantTx, invoiceId: string) {
  const inv = await tx.selectFrom('invoices').selectAll().where('id', '=', invoiceId).executeTakeFirstOrThrow();
  const lines = await tx.selectFrom('invoice_lines').select(['description', 'quantity', 'unit_minor', 'amount_minor']).where('invoice_id', '=', invoiceId).orderBy('position').execute();
  const payments = await tx.selectFrom('payment_events').select(['kind', 'amount_minor', 'fee_minor', 'currency', 'occurred_at', 'provider', 'provider_event_id']).where('invoice_id', '=', invoiceId).orderBy('occurred_at').execute();
  const ledger = await tx.selectFrom('ledger_entries').innerJoin('ledger_transactions', 'ledger_transactions.id', 'ledger_entries.transaction_id')
    .select(['ledger_transactions.kind', 'ledger_transactions.ref', 'ledger_transactions.occurred_at', 'ledger_entries.account', 'ledger_entries.direction', 'ledger_entries.amount_minor'])
    .where('ledger_entries.invoice_id', '=', invoiceId).orderBy('ledger_transactions.occurred_at').execute();
  const booking = inv.booking_id ? await tx.selectFrom('bookings').select(['id', 'starts_at', 'ends_at', 'status', 'confirmed_at', 'closed_at']).where('id', '=', inv.booking_id).executeTakeFirst() : undefined;
  const refs = [`invoice:${invoiceId}`, ...(booking ? [`booking:${booking.id}`] : [])];
  const audit = await tx.selectFrom('audit_events').select(['event_type', 'created_at', 'actor_kind']).where('subject_ref', 'in', refs).orderBy('seq').execute();
  const conversation: { at: string; direction: string; text: string }[] = [];
  if (inv.contact_id) {
    const msgs = await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id')
      .select(['messages.id', 'messages.direction', 'messages.received_at', 'messages.body_enc']).where('conversations.contact_id', '=', inv.contact_id).orderBy('messages.received_at').execute();
    for (const m of msgs) conversation.push({ at: new Date(m.received_at).toISOString(), direction: m.direction, text: await deps.keyring.openText(tx, { table: 'messages', column: 'body_enc', rowId: m.id }, m.body_enc) });
  }
  return {
    prepared_for: 'the business owner to check and submit; Sevari does not submit disputes',
    invoice: { number: inv.number, issued_at: inv.issued_at?.toISOString() ?? null, currency: inv.currency, net_minor: Number(inv.net_minor), vat_minor: Number(inv.vat_minor), total_minor: Number(inv.total_minor), paid_minor: Number(inv.paid_minor), status: inv.status, lines },
    booking: booking ?? null, payments, ledger, audit_trail: audit, conversation,
  };
}
