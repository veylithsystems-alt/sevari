/**
 * Drafts and sending under authority (§5.2, §7.1, §7.2, INV-4, INV-5, Part J §66).
 *
 * A draft is the exact payload that would be sent. It goes to a customer only through sendDraft(), which
 * needs an authority: a human approval (created from the human's answer and consumed in one statement)
 * or an active autonomy grant. sendDraft re-checks everything at the moment of sending:
 *   integrity (the stored digest still matches), freshness (every fact used is still the current version,
 *   INV-15), grounding (with the same evidence), then approval consumption, then suppression (reserve).
 * Dispatch happens after commit, in its own job, through the outbox (crash-safe, reconciled).
 */
import { randomUUID } from 'node:crypto';
import { appendAudit } from '@sevari/audit';
import { consumeApproval, createApproval, payloadDigest } from '@sevari/approvals';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { enqueue, type DraftRow, type TenantTx } from '@sevari/db';
import { ground, type GroundingFailure, type GroundingSources } from '@sevari/grounding';
import { snapshotAt } from '@sevari/knowledge';
import { normaliseRecipient, reserve, type PolicyRefusal } from '@sevari/outbound';
import { checkBookingDraft, commitBookingDraft, releaseForDraft } from './bookings.ts';
import { checkInvoiceDraft, commitInvoiceDraft, releaseInvoiceDraft } from './invoicing.ts';
import type { Lifecycles } from './journey.ts';

export const DISPATCH_JOB = 'draft.dispatch';
export const RECONCILE_JOB = 'outbox.reconcile';
export const OUTBOX_DISPATCH_JOB = 'outbox.dispatch';

export interface SendDeps {
  readonly keyring: TenantKeyring;
  readonly clock: Clock;
  /** The cell's public origin, for links in messages (e.g. a data-copy download). */
  readonly publicBaseUrl?: string;
  /** The cell's lifecycle definitions; defaults to the build's own (config/lifecycles). */
  readonly lifecycles?: Lifecycles;
}

export interface StoredSources {
  readonly factTexts: readonly string[];
  readonly factIds: readonly string[];
  readonly customerText: string;
  readonly services?: GroundingSources['services'];
}

export interface NewDraft {
  readonly enquiryId: string | null;
  readonly conversationId: string;
  readonly contactId: string;
  readonly inReplyTo: string | null;
  readonly channel: 'email' | 'sms';
  readonly recipient: string;
  readonly purpose: 'clarify' | 'reply' | 'holding';
  readonly actionClass: string;
  readonly body: string;
  readonly sources: StoredSources;
  readonly generator: 'template' | 'model' | 'human';
  readonly templateId?: string;
  readonly modelId?: string;
  readonly factsUsed: readonly string[];
  readonly parentId?: string;
  readonly draftVersion?: number;
}

const f = (column: string, rowId: string) => ({ table: 'drafts', column, rowId });

export async function createDraft(deps: SendDeps, tx: TenantTx, d: NewDraft): Promise<{ id: string; digest: Buffer }> {
  const id = randomUUID();
  const recipient = normaliseRecipient(d.channel, d.recipient);
  const digest = payloadDigest({ actionClass: d.actionClass, channel: d.channel, recipient, body: d.body });
  await tx.insertInto('drafts').values({
    id, tenant_id: tx.scope.tenantId, region: tx.scope.region, enquiry_id: d.enquiryId, conversation_id: d.conversationId, contact_id: d.contactId,
    in_reply_to: d.inReplyTo, parent_id: d.parentId ?? null, ...(d.draftVersion ? { draft_version: d.draftVersion } : {}),
    channel: d.channel, purpose: d.purpose, action_class: d.actionClass,
    recipient_enc: await deps.keyring.seal(tx, { ...f('recipient_enc', id), subject: d.contactId }, recipient),
    body_enc: await deps.keyring.seal(tx, { ...f('body_enc', id), subject: d.contactId }, d.body),
    sources_enc: await deps.keyring.seal(tx, { ...f('sources_enc', id), subject: d.contactId }, JSON.stringify(d.sources)),
    content_digest: digest, generator: d.generator, template_id: d.templateId ?? null, model_id: d.modelId ?? null, facts_used: [...d.factsUsed],
  }).execute();
  await appendAudit(tx, { type: 'draft.created', actor: { kind: 'system' }, subject: `draft:${id}`, payload: { generator: d.generator, action_class: d.actionClass, purpose: d.purpose, facts_used: d.factsUsed.length, ...(d.parentId ? { parent: `draft:${d.parentId}` } : {}) } });
  return { id, digest };
}

export interface LoadedDraft {
  readonly row: DraftRow;
  readonly body: string;
  readonly recipient: string;
  readonly sources: StoredSources;
}

export async function loadDraft(deps: SendDeps, tx: TenantTx, draftId: string, lock = false): Promise<LoadedDraft | null> {
  const q = tx.selectFrom('drafts').selectAll().where('id', '=', draftId);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) return null;
  return {
    row,
    body: await deps.keyring.openText(tx, f('body_enc', row.id), row.body_enc),
    recipient: await deps.keyring.openText(tx, f('recipient_enc', row.id), row.recipient_enc),
    sources: JSON.parse(await deps.keyring.openText(tx, f('sources_enc', row.id), row.sources_enc)) as StoredSources,
  };
}

export type Authority =
  | { readonly kind: 'approval'; readonly inputId: string; readonly approverId: string }
  | { readonly kind: 'grant'; readonly grantId: string };

export type SendRefusal = 'not_pending' | 'tampered' | 'stale_facts' | 'grounding' | 'approval' | 'suppressed' | 'booking_lost' | 'booking_changed' | 'contact_rules' | 'invoice_changed';
export type SendResult =
  | { readonly status: 'queued'; readonly outboxId: string }
  | { readonly status: 'refused'; readonly reason: SendRefusal; readonly failures?: readonly GroundingFailure[]; readonly rule?: PolicyRefusal };

/** Extra evidence a human supplied (their own edited or written text), cited by the input that carried it. */
export interface OwnerFacts { readonly texts: readonly string[]; readonly ids: readonly string[] }

export async function sendDraft(deps: SendDeps, tx: TenantTx, draftId: string, authority: Authority, owner?: OwnerFacts, opts: { readonly receiptByDispatch?: boolean } = {}): Promise<SendResult> {
  const d = await loadDraft(deps, tx, draftId, true);
  if (!d || d.row.status !== 'pending_approval') return { status: 'refused', reason: 'not_pending' };
  // A draft that will never go lets go of any slot it was holding.
  const setStatus = async (status: DraftRow['status']) => {
    await tx.updateTable('drafts').set({ status }).where('id', '=', draftId).execute();
    await releaseForDraft(deps, tx, draftId);
    await releaseInvoiceDraft(tx, draftId);
  };

  // Integrity: what is about to be sent is exactly what was approved (§7.1).
  const digest = payloadDigest({ actionClass: d.row.action_class, channel: d.row.channel, recipient: d.recipient, body: d.body });
  if (!digest.equals(d.row.content_digest)) {
    await setStatus('blocked');
    return { status: 'refused', reason: 'tampered' };
  }
  // Freshness (INV-15): a fact that changed since the draft was written makes the draft stale.
  const snap = await snapshotAt(tx, deps.keyring, deps.clock.nowMs());
  const current = new Set([snap.business, snap.hours, ...snap.services, ...snap.prices, ...snap.areas, ...snap.policies, ...snap.faqs]
    .filter((x) => x !== undefined).map((x) => `${x.id}@${x.version}`));
  // Booking and invoice facts are checked against those records themselves, below.
  if (d.row.facts_used.filter((id) => !id.startsWith('booking:') && !id.startsWith('offer:') && !id.startsWith('invoice:')).some((id) => !current.has(id))) {
    await setStatus('superseded');
    return { status: 'refused', reason: 'stale_facts' };
  }
  const g = ground(d.body, d.row.purpose === 'holding' ? 'holding' : d.row.purpose, {
    factTexts: [...d.sources.factTexts, ...(owner?.texts ?? [])], factIds: [...d.sources.factIds, ...(owner?.ids ?? [])],
    customerText: d.sources.customerText, ...(d.sources.services ? { services: d.sources.services } : {}),
  }, { nowMs: deps.clock.nowMs(), timezone: snap.hours?.body.timezone ?? 'Europe/London' });
  if (!g.ok) {
    await setStatus('blocked');
    return { status: 'refused', reason: 'grounding', failures: g.failures };
  }
  const booking = await checkBookingDraft(tx, snap.hours?.body.timezone ?? 'Europe/London', d.row, d.body);
  if (booking) {
    await setStatus(booking === 'stale_facts' ? 'superseded' : 'blocked');
    return { status: 'refused', reason: booking };
  }
  const invoice = await checkInvoiceDraft(tx, d.row, d.body);
  if (invoice) {
    await setStatus('blocked');
    return { status: 'refused', reason: invoice };
  }
  let approvalId: string | null = null;
  if (authority.kind === 'approval') {
    approvalId = await createApproval(tx, { draftId, actionClass: d.row.action_class, digest, approverId: authority.approverId, inputId: authority.inputId });
    if (!(await consumeApproval(tx, approvalId, digest))) return { status: 'refused', reason: 'approval' };
  } else {
    const live = await tx.selectFrom('autonomy_grants').select('id').where('id', '=', authority.grantId).where('revoked_at', 'is', null).where('action_class', '=', d.row.action_class).executeTakeFirst();
    if (!live) return { status: 'refused', reason: 'approval' };
  }
  const r = await reserve(tx, deps.keyring, deps.clock, {
    draft: g.draft, conversationId: d.row.conversation_id, contactId: d.row.contact_id, ...(d.row.in_reply_to ? { inReplyTo: d.row.in_reply_to } : {}),
    channel: d.row.channel, recipient: d.recipient, actionClass: d.row.action_class, dedupeKey: `draft:${draftId}`,
    ...(d.row.template_id ? { templateId: d.row.template_id } : {}),
  });
  if (r.status === 'suppressed') {
    await setStatus('blocked');
    return { status: 'refused', reason: 'suppressed' };
  }
  if (r.status === 'refused') {
    // The approval was consumed for nothing: record that the rules, not the person, stopped it.
    await setStatus('blocked');
    await appendAudit(tx, { type: 'draft.refused_by_contact_rules', actor: { kind: 'system' }, subject: `draft:${draftId}`, payload: { rule: r.reason } });
    return { status: 'refused', reason: 'contact_rules', rule: r.reason };
  }
  await tx.updateTable('drafts').set({ status: 'approved', outbox_id: r.outboxId }).where('id', '=', draftId).execute();
  // The business has now committed: the offer counts as made, the held slot becomes a booking (§24).
  await commitBookingDraft(deps, tx, d.row, approvalId ? { kind: 'approval', approvalId } : { kind: 'grant', grantId: (authority as { grantId: string }).grantId });
  await commitInvoiceDraft(deps, tx, d.row);
  await enqueue(tx, { kind: DISPATCH_JOB, dedupeKey: `dispatch:${draftId}`, ...(r.notBefore ? { runAt: r.notBefore } : {}), payload: { draft_id: draftId, outbox_id: r.outboxId, input_id: authority.kind === 'approval' && opts.receiptByDispatch !== false ? authority.inputId : null, grant_id: authority.kind === 'grant' ? authority.grantId : null } });
  await appendAudit(tx, { type: 'draft.authorised', actor: authority.kind === 'approval' ? { kind: 'user', ref: authority.approverId } : { kind: 'system', ref: `grant:${authority.grantId}` }, subject: `draft:${draftId}`, payload: { authority: authority.kind, outbox_ref: `outbox:${r.outboxId}` } });
  return { status: 'queued', outboxId: r.outboxId };
}

const REFUSAL_TEXT: Record<SendRefusal, string> = {
  not_pending: 'This reply had already been dealt with, so nothing more was sent.',
  tampered: 'This reply did not match what was approved, so it was blocked. Nothing was sent. The team has been alerted.',
  stale_facts: 'Your business details changed after this reply was written, so it was not sent. Please check the new details and reply again.',
  grounding: 'This reply contains something that is not in your confirmed records, so it was not sent.',
  approval: 'The approval could not be used (it may have expired or already been used). Nothing was sent.',
  suppressed: 'This customer has asked not to be contacted, so nothing was sent.',
  booking_lost: 'The time in this message is no longer held (it lapsed, or the booking changed), so nothing was sent. The customer has not been told anything.',
  booking_changed: 'A booking message must state the booked time exactly as it was held, so this version was not sent. Nothing was booked or changed.',
  invoice_changed: 'An invoice message must state the invoice\'s exact total and payment link, so this version was not sent. No invoice was issued.',
  contact_rules: 'Not sent: the contact rules don\'t allow this message to this person (for example, no consent for it, or too many messages recently). Nothing was sent.',
};
export const refusalText = (r: SendRefusal) => REFUSAL_TEXT[r];

export const clockTime = (ms: number, tz = 'Europe/London') =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(ms);
