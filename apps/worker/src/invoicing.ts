/**
 * Invoicing in the worker (§19.2). When the owner confirms a job is done:
 *   invoice.prepare  a draft invoice from the owner's confirmed price (or the amount the owner gives, if the
 *                    price wasn't fixed), a payment link from the business's own processor (made outside any
 *                    database transaction), and the message for the owner to approve (invoice_send).
 *   on approval      the invoice is issued (numbered, posted to the ledger) in the same transaction as the send.
 *   on refusal       the draft invoice is voided and its link cancelled; no number is used.
 *   invoice.chase    after the due date, reminders on the owner's schedule, each approved like any message.
 * The message must state the invoice's exact total (and link): an edit can't change what is asked for.
 */
import { appendAudit } from '@sevari/audit';
import { decide } from '@sevari/autonomy';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { enqueue, sql, withTenant, type Db, type DraftRow, type TenantTx } from '@sevari/db';
import { ContractViolation, type TenantScope } from '@sevari/domain';
import { draftInvoice, formatMoney, issueInvoice, moneyPortFor, outstanding, voidDraftInvoice, type PaymentProcessor } from '@sevari/finance';
import { ground } from '@sevari/grounding';
import { ask, digestOf, type Consumer, type ConsumerRegistry } from '@sevari/hitl';
import { snapshotAt } from '@sevari/knowledge';
import { render } from '@sevari/templates';
import { customerOf } from './respond.ts';
import { createDraft, sendDraft } from './sending.ts';

export const INVOICE_PREPARE_JOB = 'invoice.prepare';
export const INVOICE_CHASE_JOB = 'invoice.chase';
/** Days after the due date for each reminder, and the most reminders (the owner can change these). */
export const DEFAULT_CHASE_DAYS = [1, 7, 14] as const;

export interface InvoicingDeps {
  readonly db: Db;
  readonly keyring: TenantKeyring;
  readonly clock: Clock;
  readonly consumers: ConsumerRegistry;
  /** The business's own payment processor. Without one, invoices go out without a payment link. */
  readonly payments?: PaymentProcessor;
}

const vatNote = (t: 'inclusive' | 'exclusive' | 'not_registered') => (t === 'not_registered' ? '' : ' including VAT');

async function chain(tx: TenantTx, draftId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let id: string | null = draftId; id && ids.length < 20;) {
    ids.push(id);
    id = (await tx.selectFrom('drafts').select('parent_id').where('id', '=', id).executeTakeFirst())?.parent_id ?? null;
  }
  return ids;
}

/** At send time: the message still states this invoice's exact total (and link). */
export async function checkInvoiceDraft(tx: TenantTx, draft: DraftRow, body: string): Promise<'invoice_changed' | null> {
  const invs = await tx.selectFrom('invoices').select(['id', 'total_minor', 'currency', 'status']).where('send_draft_id', 'in', await chain(tx, draft.id)).execute();
  for (const i of invs) {
    if (i.status !== 'draft') return 'invoice_changed';
    if (!body.includes(formatMoney(Number(i.total_minor), i.currency))) return 'invoice_changed';
    const link = await tx.selectFrom('payment_links').select('url').where('invoice_id', '=', i.id).where('status', '=', 'open').executeTakeFirst();
    if (link && !body.includes(link.url)) return 'invoice_changed';
  }
  return null;
}

/** The send is authorised: the invoice is issued now, and its reminders scheduled. */
export async function commitInvoiceDraft(deps: { clock: Clock }, tx: TenantTx, draft: DraftRow): Promise<void> {
  const invs = await tx.selectFrom('invoices').select('id').where('send_draft_id', 'in', await chain(tx, draft.id)).where('status', '=', 'draft').execute();
  for (const i of invs) {
    await issueInvoice(deps, tx, i.id);
    const inv = await tx.selectFrom('invoices').select(sql<string | null>`due_on::text`.as('due_on')).where('id', '=', i.id).executeTakeFirstOrThrow();
    if (inv.due_on) await enqueue(tx, { kind: INVOICE_CHASE_JOB, dedupeKey: `chase:${i.id}:0`, runAt: new Date(Date.parse(`${inv.due_on}T09:00:00Z`) + DEFAULT_CHASE_DAYS[0] * 86_400_000), payload: { invoice_id: i.id, round: 0 } });
  }
}

/** The send won't happen: void the draft invoice (no number used) and cancel its link. */
export async function releaseInvoiceDraft(tx: TenantTx, draftId: string): Promise<void> {
  for (const i of await tx.selectFrom('invoices').select('id').where('send_draft_id', 'in', await chain(tx, draftId)).where('status', '=', 'draft').execute()) await voidDraftInvoice(tx, i.id);
}

interface Prepared { invoiceId: string; total: number; currency: string; service: string; vat: 'inclusive' | 'exclusive' | 'not_registered'; messageId: string }

/** Job invoice.prepare: draft (tx 1), payment link (no transaction), message + approval question (tx 2). */
export function invoicePrepareHandler(deps: InvoicingDeps) {
  return {
    scoped: async (scope: TenantScope, p: Record<string, unknown>) => {
      const bookingId = String(p['booking_id']);
      const amountOverride = p['amount_minor'] !== undefined && p['amount_minor'] !== null ? Number(p['amount_minor']) : null;
      const prep = await withTenant(deps.db, scope, async (tx): Promise<Prepared | string> => {
        const existing = await tx.selectFrom('invoices').select('id').where('booking_id', '=', bookingId).where('status', '<>', 'void').executeTakeFirst();
        if (existing) return 'already';
        const b = await tx.selectFrom('bookings').select(['id', 'contact_id', 'conversation_id', 'service', 'status']).where('id', '=', bookingId).executeTakeFirst();
        if (!b || b.status !== 'completed' || !b.conversation_id) return 'not_completed';
        const snap = await snapshotAt(tx, deps.keyring, deps.clock.nowMs());
        const svc = snap.services.find((s) => s.body.code === b.service);
        const price = snap.prices.find((x) => x.body.service_code === b.service && x.body.basis !== 'call_out');
        const fixed = price?.body.basis === 'fixed' ? price.body.amount_minor ?? null : null;
        const amount = amountOverride ?? fixed;
        const service = svc?.body.name ?? (b.service ?? 'the job').replace(/_/g, ' ');
        if (amount === null || !price) {
          await ask({ keyring: deps.keyring, clock: deps.clock, consumers: deps.consumers }, tx, {
            subjectContactId: b.contact_id, kind: 'owner_task', subjectRef: `invoice-amount:${bookingId}`, contentDigest: digestOf({ booking: bookingId }), requiredRole: 'owner',
            body: { title: 'How much should the invoice be?', summary: `The ${service} job is done. Your price for it isn't fixed, so please give the amount to invoice (for example 120 or 120.50).`, optionLabels: { amount: 'Enter the amount', no_invoice: 'No invoice for this job' }, safeDefaultText: 'No invoice is sent until you give the amount.' },
            options: ['amount', 'no_invoice'], safeDefault: 'hold', consumer: { kind: 'invoice.amount', ref: bookingId }, deadlineMs: 14 * 86_400_000,
          });
          return 'asked_amount';
        }
        const vat = price.body.vat;
        const inv = await draftInvoice(tx, { contactId: b.contact_id, bookingId, vatTreatment: vat, lines: [{ description: service, quantity: 1, unitMinor: amount, sourceRef: `booking:${bookingId}` }], factsUsed: [`${price.id}@${price.version}`] });
        const msg = await tx.selectFrom('messages').select('id').where('conversation_id', '=', b.conversation_id).where('direction', '=', 'inbound').orderBy('received_at', 'desc').executeTakeFirstOrThrow();
        return { invoiceId: inv.id, total: inv.total, currency: inv.currency, service, vat, messageId: msg.id };
      });
      if (typeof prep === 'string') return prep;
      let link: { providerLinkId: string; url: string; provider: string } | null = null;
      if (deps.payments) {
        const port = await withTenant(deps.db, scope, (tx) => moneyPortFor(tx, deps.payments as PaymentProcessor));
        link = await port.createPaymentLink({ reference: prep.invoiceId, amountMinor: prep.total, currency: prep.currency, description: prep.service });
      }
      return withTenant(deps.db, scope, async (tx) => {
        if (link) await tx.insertInto('payment_links').values({ tenant_id: scope.tenantId, region: scope.region, invoice_id: prep.invoiceId, provider: link.provider, provider_link_id: link.providerLinkId, url: link.url, amount_minor: prep.total, currency: prep.currency }).execute();
        const snap = await snapshotAt(tx, deps.keyring, deps.clock.nowMs());
        const business = snap.business?.body;
        const c = await customerOf(deps, tx, prep.messageId);
        if (!business || !c.channel || !c.recipient) throw new ContractViolation('§19.2', 'no business record or no way to reach the customer for an invoice');
        const total = formatMoney(prep.total, prep.currency);
        const r = render('invoice', c.channel, { business: business.trading_name, replyTime: business.reply_time_statement, privacyUrl: business.privacy_notice_url, discloseAutomation: false,
          invoice: { service: prep.service, total, vatNote: vatNote(prep.vat), ...(link ? { link: link.url } : {}) } });
        if (!r.ok) throw new ContractViolation('§19.2', `invoice template: ${r.reason}`);
        const facts = [`Invoice total ${total}${vatNote(prep.vat)}.`, business.trading_name, ...(link ? [link.url] : [])];
        const g = ground(r.text, 'reply', { factTexts: facts, factIds: [`invoice:${prep.invoiceId}`], customerText: '' }, { nowMs: deps.clock.nowMs(), timezone: snap.hours?.body.timezone ?? 'Europe/London' });
        if (!g.ok) throw new ContractViolation('§19.2', `invoice message failed the fact check: ${g.failures.map((f) => f.detail).join('; ')}`);
        const d = await createDraft(deps, tx, {
          enquiryId: null, conversationId: c.conversationId, contactId: c.contactId, inReplyTo: null, channel: c.channel, recipient: c.recipient, purpose: 'reply',
          actionClass: 'invoice_send', body: g.draft.text, sources: { factTexts: facts, factIds: [`invoice:${prep.invoiceId}`], customerText: '' }, generator: 'template', templateId: 'invoice', factsUsed: [`invoice:${prep.invoiceId}`],
        });
        await tx.updateTable('invoices').set({ send_draft_id: d.id }).where('id', '=', prep.invoiceId).execute();
        const decision = await decide(tx, 'invoice_send');
        if (decision.mode === 'granted') {
          const s = await sendDraft(deps, tx, d.id, { kind: 'grant', grantId: decision.grantId });
          if (s.status === 'queued') return 'sent_under_grant';
        }
        await ask({ keyring: deps.keyring, clock: deps.clock, consumers: deps.consumers }, tx, {
          subjectContactId: c.contactId, kind: 'approve_draft', subjectRef: `draft:${d.id}`, actionClass: 'invoice_send', contentDigest: d.digest, requiredRole: 'owner',
          body: { title: 'Invoice ready to send', summary: `For ${prep.service}: ${total}${vatNote(prep.vat)}. Approving issues the invoice (it gets its number then) and sends it${link ? ' with a payment link' : ''}.`, preview: g.draft.text, facts,
            optionLabels: { approve: 'Send it', edit: 'Change the message', reject: 'Don\'t send' }, safeDefaultText: 'No invoice is issued or sent until you approve.' },
          options: ['approve', 'edit', 'reject'], safeDefault: 'hold', consumer: { kind: 'draft.send', ref: d.id }, deadlineMs: 14 * 86_400_000,
        });
        await appendAudit(tx, { type: 'invoice.prepared', actor: { kind: 'system' }, subject: `invoice:${prep.invoiceId}`, payload: { total_minor: prep.total, link: Boolean(link) } });
        return 'awaiting_approval';
      });
    },
  };
}

/** Job invoice.chase: a reminder after the due date, on the owner's schedule, while anything is unpaid. */
export async function chaseInvoice(deps: InvoicingDeps, tx: TenantTx, p: Record<string, unknown>): Promise<string> {
  const invoiceId = String(p['invoice_id']);
  const round = Number(p['round']);
  const inv = await tx.selectFrom('invoices').selectAll().select(sql<string | null>`due_on::text`.as('due_on')).where('id', '=', invoiceId).executeTakeFirst();
  if (!inv || !(inv.status === 'issued' || inv.status === 'part_paid') || !inv.contact_id || !inv.due_on || !inv.number) return 'nothing_to_chase';
  const conv = await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id').select('messages.id')
    .where('conversations.contact_id', '=', inv.contact_id).where('messages.direction', '=', 'inbound').orderBy('messages.received_at', 'desc').executeTakeFirst();
  if (!conv) return 'no_conversation';
  const c = await customerOf(deps, tx, conv.id);
  const snap = await snapshotAt(tx, deps.keyring, deps.clock.nowMs());
  const business = snap.business?.body;
  if (!business || !c.channel || !c.recipient) return 'no_channel';
  const due = Number(outstanding(inv));
  const total = formatMoney(due, inv.currency);
  const link = await tx.selectFrom('payment_links').select('url').where('invoice_id', '=', invoiceId).where('status', '=', 'open').executeTakeFirst();
  const r = render('invoice_reminder', c.channel, { business: business.trading_name, replyTime: business.reply_time_statement, privacyUrl: business.privacy_notice_url, discloseAutomation: false,
    invoice: { service: '', total, vatNote: '', number: inv.number, dueOn: inv.due_on, ...(link ? { link: link.url } : {}) } });
  if (!r.ok) return `template:${r.reason}`;
  const facts = [`Invoice ${inv.number} for ${total} was due on ${inv.due_on}.`, business.trading_name, ...(link ? [link.url] : [])];
  const g = ground(r.text, 'reply', { factTexts: facts, factIds: [`invoice:${invoiceId}`], customerText: '' }, { nowMs: deps.clock.nowMs(), timezone: snap.hours?.body.timezone ?? 'Europe/London' });
  if (!g.ok) return 'blocked_grounding';
  const d = await createDraft(deps, tx, { enquiryId: null, conversationId: c.conversationId, contactId: c.contactId, inReplyTo: null, channel: c.channel, recipient: c.recipient, purpose: 'reply',
    actionClass: 'invoice_send', body: g.draft.text, sources: { factTexts: facts, factIds: [`invoice:${invoiceId}`], customerText: '' }, generator: 'template', templateId: 'invoice_reminder', factsUsed: [`invoice:${invoiceId}`] });
  await ask({ keyring: deps.keyring, clock: deps.clock, consumers: deps.consumers }, tx, {
    subjectContactId: c.contactId, kind: 'approve_draft', subjectRef: `draft:${d.id}`, actionClass: 'invoice_send', contentDigest: d.digest, requiredRole: 'owner',
    body: { title: 'Payment reminder ready', summary: `Invoice ${inv.number} (${total} unpaid) was due on ${inv.due_on}. No interest or charges are added.`, preview: g.draft.text, facts,
      optionLabels: { approve: 'Send it', edit: 'Change it', reject: 'Don\'t send' }, safeDefaultText: 'Nothing is sent until you approve.' },
    options: ['approve', 'edit', 'reject'], safeDefault: 'hold', consumer: { kind: 'draft.send', ref: d.id }, deadlineMs: 7 * 86_400_000,
  });
  const next = DEFAULT_CHASE_DAYS[round + 1];
  if (next !== undefined) await enqueue(tx, { kind: INVOICE_CHASE_JOB, dedupeKey: `chase:${invoiceId}:${round + 1}`, runAt: new Date(Date.parse(`${inv.due_on}T09:00:00Z`) + next * 86_400_000), payload: { invoice_id: invoiceId, round: round + 1 } });
  return 'reminder_drafted';
}

/** The owner's answer to "how much should the invoice be?": the amount, typed by them. */
export function invoicingConsumers(): Record<string, Consumer> {
  return {
    'invoice.amount': {
      ack: (r) => (r === 'no_invoice' ? 'Understood. No invoice for this job.' : 'Thanks. Preparing the invoice now.'),
      async apply(ctx) {
        const bookingId = ctx.question.consumer_ref;
        if (ctx.response === 'no_invoice') return { status: 'done', effectKind: 'invoice.skipped', effectRef: `booking:${bookingId}`, outcomeText: 'No invoice will be sent for this job.' };
        const m = /^\s*£?\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(ctx.detail ?? '');
        if (!m) return { status: 'failed', effectKind: 'invoice.amount', effectRef: `booking:${bookingId}`, outcomeText: 'That amount wasn\'t clear, so no invoice was made. Please answer again with just the amount, for example 120 or 120.50.' };
        const minor = Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
        await enqueue(ctx.tx, { kind: INVOICE_PREPARE_JOB, dedupeKey: `invoice:${bookingId}:${minor}`, payload: { booking_id: bookingId, amount_minor: minor } });
        return { status: 'done', effectKind: 'invoice.amount', effectRef: `booking:${bookingId}`, outcomeText: `Got it: ${formatMoney(minor)}. The invoice will be ready for you to approve in a moment.` };
      },
    },
  };
}
