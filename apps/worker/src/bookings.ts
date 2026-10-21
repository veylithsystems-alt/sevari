/**
 * Bookings (§16.1 stages 3, 4, 6; §24: bookings need approval until a grant is earned; cancel never
 * automatic). The rules:
 *   - only a window that was actually offered to this customer can become a booking;
 *   - choosing one HOLDS the slot (the database refuses any overlap), while a confirmation waits for
 *     approval; the booking becomes real only when that confirmation is authorised;
 *   - a confirmation must state the held time exactly, so an edit can't quietly book a different time;
 *   - a rejected, expired or blocked confirmation releases the hold; a backstop job releases it anyway.
 */
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import { enqueue, type DraftRow, type TenantTx } from '@sevari/db';
import { ContractViolation, localParts, slotPhrase, type BookingFact, type Busy, type SlotTimes } from '@sevari/domain';
import { journeyEvent, type JourneyDeps } from './journey.ts';

export const RELEASE_HOLD_JOB = 'booking.release_hold';
/** How long offered times stay choosable (they also lapse as each time passes). */
export const OFFER_TTL_MS = 14 * 86_400_000;

export type LocalSlot = SlotTimes & { readonly startMs: number; readonly endMs: number };
export function localSlot(startMs: number, endMs: number, tz: string): LocalSlot {
  const a = localParts(startMs, tz);
  return { date: a.date, start: a.time, end: localParts(endMs, tz).time, startMs, endMs };
}

/** Held and confirmed slots from a time onward: what availability must avoid. */
export async function busyTimes(tx: TenantTx, fromMs: number): Promise<Busy[]> {
  const rows = await tx.selectFrom('bookings').select(['starts_at', 'ends_at']).where('status', 'in', ['held', 'confirmed']).where('ends_at', '>', new Date(fromMs)).execute();
  return rows.map((r) => ({ startMs: r.starts_at.getTime(), endMs: r.ends_at.getTime() }));
}

/** This customer's next confirmed booking, as a fact a reply may state. */
export async function upcomingBooking(tx: TenantTx, contactId: string, nowMs: number, tz: string): Promise<BookingFact | undefined> {
  const b = await tx.selectFrom('bookings').select(['id', 'starts_at', 'ends_at', 'service']).where('contact_id', '=', contactId).where('status', '=', 'confirmed')
    .where('ends_at', '>', new Date(nowMs)).orderBy('starts_at').executeTakeFirst();
  if (!b) return undefined;
  return { id: b.id, ...localSlot(b.starts_at.getTime(), b.ends_at.getTime(), tz), ...(b.service ? { service: b.service } : {}) };
}

export async function recordOffer(tx: TenantTx, o: {
  contactId: string; conversationId: string; enquiryId: string | null; draftId: string; service: string | null;
  windows: readonly LocalSlot[]; rescheduleOf: string | null; nowMs: number;
}): Promise<string> {
  const last = Math.max(...o.windows.map((w) => w.startMs));
  const r = await tx.insertInto('booking_offers').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, contact_id: o.contactId, conversation_id: o.conversationId, enquiry_id: o.enquiryId,
    draft_id: o.draftId, service: o.service, windows: JSON.stringify(o.windows.map((w) => ({ startMs: w.startMs, endMs: w.endMs, date: w.date, start: w.start, end: w.end }))),
    reschedule_of: o.rescheduleOf, offered_at: new Date(o.nowMs), expires_at: new Date(Math.max(o.nowMs + 60_000, Math.min(last, o.nowMs + OFFER_TTL_MS))),
  }).returning('id').executeTakeFirstOrThrow();
  return r.id;
}

/** The latest offer this conversation was actually sent, still open, with only the times still ahead. */
export async function liveOffer(tx: TenantTx, conversationId: string, nowMs: number) {
  const o = await tx.selectFrom('booking_offers').selectAll().where('conversation_id', '=', conversationId).where('status', '=', 'sent')
    .where('expires_at', '>', new Date(nowMs)).orderBy('offered_at', 'desc').executeTakeFirst();
  if (!o) return undefined;
  const windows = o.windows.filter((w) => w.startMs > nowMs);
  return windows.length ? { ...o, windows } : undefined;
}

/** Holds a slot, or returns null if anyone already holds or has booked an overlapping time. */
export async function holdSlot(tx: TenantTx, h: {
  contactId: string; conversationId: string; enquiryId: string | null; offerId: string; service: string | null;
  slot: LocalSlot; holdUntilMs: number; replacesId: string | null;
}): Promise<string | null> {
  const r = await tx.insertInto('bookings').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, contact_id: h.contactId, conversation_id: h.conversationId, enquiry_id: h.enquiryId,
    offer_id: h.offerId, service: h.service, starts_at: new Date(h.slot.startMs), ends_at: new Date(h.slot.endMs), status: 'held',
    hold_expires_at: new Date(h.holdUntilMs), replaces_id: h.replacesId,
  }).onConflict((oc) => oc.doNothing()).returning('id').executeTakeFirst();
  if (!r) return null;
  await enqueue(tx, { kind: RELEASE_HOLD_JOB, dedupeKey: `hold:${r.id}`, runAt: new Date(h.holdUntilMs), payload: { booking_id: r.id } });
  await appendAudit(tx, { type: 'booking.held', actor: { kind: 'system' }, subject: `booking:${r.id}`, payload: { offer: `offer:${h.offerId}`, until: new Date(h.holdUntilMs).toISOString(), ...(h.replacesId ? { replaces: `booking:${h.replacesId}` } : {}) } });
  return r.id;
}

/** The draft and every draft it was edited from: a booking stays attached through edits. */
async function draftChain(tx: TenantTx, draftId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let id: string | null = draftId; id && ids.length < 20;) {
    ids.push(id);
    const row: { parent_id: string | null } | undefined = await tx.selectFrom('drafts').select('parent_id').where('id', '=', id).executeTakeFirst();
    id = row?.parent_id ?? null;
  }
  return ids;
}

export type BookingRefusal = 'booking_lost' | 'booking_changed' | 'stale_facts';

/**
 * Checks a draft's booking promises still hold, at the moment of sending: the slot is still held (or the
 * booking still exists), and the message states that exact time.
 */
export async function checkBookingDraft(tx: TenantTx, tz: string, draft: DraftRow, body: string): Promise<BookingRefusal | null> {
  const chain = await draftChain(tx, draft.id);
  const states = (b: { starts_at: Date; ends_at: Date }) => slotPhrase(localSlot(b.starts_at.getTime(), b.ends_at.getTime(), tz));
  const held = await tx.selectFrom('bookings').select(['id', 'status', 'starts_at', 'ends_at']).where('draft_id', 'in', chain).execute();
  for (const b of held) {
    if (b.status !== 'held') return 'booking_lost';
    if (!body.includes(states(b))) return 'booking_changed';
  }
  const cancelling = await tx.selectFrom('bookings').select(['id', 'status', 'starts_at', 'ends_at']).where('cancel_draft_id', 'in', chain).execute();
  for (const b of cancelling) {
    if (b.status !== 'confirmed') return 'booking_lost';
    if (!body.includes(states(b))) return 'booking_changed';
  }
  // A reply that states an existing booking is stale if that booking has since changed.
  const cited = draft.facts_used.filter((f) => f.startsWith('booking:')).map((f) => f.slice('booking:'.length));
  if (cited.length) {
    const live = await tx.selectFrom('bookings').select('id').where('id', 'in', cited).where('status', '=', 'confirmed').execute();
    if (live.length !== new Set(cited).size) return 'stale_facts';
  }
  return null;
}

export type BookingAuthority = { readonly kind: 'approval'; readonly approvalId: string } | { readonly kind: 'grant'; readonly grantId: string };

/** The confirmation is authorised: the offer is now sent, the hold becomes a booking, a cancellation takes effect. */
export async function commitBookingDraft(deps: JourneyDeps, tx: TenantTx, draft: DraftRow, authority: BookingAuthority): Promise<void> {
  const chain = await draftChain(tx, draft.id);
  const now = deps.clock.now();
  const actor = authority.kind === 'approval' ? `approval:${authority.approvalId}` : `grant:${authority.grantId}`;
  const offers = await tx.updateTable('booking_offers').set({ status: 'sent' }).where('draft_id', 'in', chain).where('status', '=', 'pending').returning('id').execute();
  for (const o of offers) {
    await journeyEvent(deps, tx, draft.contact_id, { event: 'offer_sent', idempotencyKey: `offer:${o.id}`, actor, authority });
  }
  const held = await tx.selectFrom('bookings').select(['id', 'ends_at', 'replaces_id', 'offer_id']).where('draft_id', 'in', chain).where('status', '=', 'held').execute();
  for (const b of held) {
    await tx.updateTable('bookings').set({ status: 'confirmed', confirmed_at: now, hold_expires_at: null }).where('id', '=', b.id).execute();
    if (b.replaces_id) await tx.updateTable('bookings').set({ status: 'rescheduled', closed_at: now }).where('id', '=', b.replaces_id).where('status', '=', 'confirmed').execute();
    await appendAudit(tx, { type: 'booking.confirmed', actor: { kind: authority.kind === 'approval' ? 'user' : 'system', ref: actor }, subject: `booking:${b.id}`, payload: { authority: authority.kind, ...(b.replaces_id ? { replaces: `booking:${b.replaces_id}` } : {}) } });
    const r = await journeyEvent(deps, tx, draft.contact_id, {
      event: b.replaces_id ? 'booking_rescheduled' : 'booking_confirmed', idempotencyKey: `booking:${b.id}`, actor, authority,
      anchors: { booking_id: b.id, booking_end: b.ends_at.getTime() },
    });
    if (r.status === 'needs_authority') throw new ContractViolation('§16', `booking ${b.id} was authorised but its journey step was refused (${r.reason})`);
  }
  const cancelled = await tx.updateTable('bookings').set({ status: 'cancelled', closed_at: now }).where('cancel_draft_id', 'in', chain).where('status', '=', 'confirmed').returning('id').execute();
  for (const b of cancelled) {
    await appendAudit(tx, { type: 'booking.cancelled', actor: { kind: 'user', ref: actor }, subject: `booking:${b.id}`, payload: { authority: authority.kind } });
    const r = await journeyEvent(deps, tx, draft.contact_id, { event: 'booking_cancelled', idempotencyKey: `cancel:${b.id}`, actor, authority });
    if (r.status === 'needs_authority') throw new ContractViolation('§16', `cancellation of ${b.id} was authorised but its journey step was refused (${r.reason})`);
  }
}

/** The confirmation won't go: let the slot go, withdraw the offer, keep the booking that was to be cancelled. */
export async function releaseForDraft(deps: { clock: Clock }, tx: TenantTx, draftId: string): Promise<void> {
  const chain = await draftChain(tx, draftId);
  const now = deps.clock.now();
  const released = await tx.updateTable('bookings').set({ status: 'released', closed_at: now, hold_expires_at: null }).where('draft_id', 'in', chain).where('status', '=', 'held').returning(['id', 'offer_id']).execute();
  // The customer can still choose from the times they were offered.
  const offerIds = released.map((b) => b.offer_id).filter((x): x is string => x !== null);
  if (offerIds.length) await tx.updateTable('booking_offers').set({ status: 'sent' }).where('id', 'in', offerIds).where('status', '=', 'taken').execute();
  for (const b of released) await appendAudit(tx, { type: 'booking.released', actor: { kind: 'system' }, subject: `booking:${b.id}`, payload: { reason: 'confirmation_not_sent' } });
  await tx.updateTable('booking_offers').set({ status: 'withdrawn' }).where('draft_id', 'in', chain).where('status', '=', 'pending').execute();
  await tx.updateTable('bookings').set({ cancel_draft_id: null }).where('cancel_draft_id', 'in', chain).execute();
}

/** Backstop: a hold past its time is released whatever else happened. */
export async function releaseHold(deps: { clock: Clock }, tx: TenantTx, bookingId: string): Promise<string> {
  const b = await tx.selectFrom('bookings').select(['status', 'hold_expires_at', 'offer_id']).where('id', '=', bookingId).executeTakeFirst();
  if (!b || b.status !== 'held') return b?.status ?? 'gone';
  if (b.hold_expires_at && b.hold_expires_at.getTime() > deps.clock.nowMs()) throw new Error('hold not expired yet');
  await tx.updateTable('bookings').set({ status: 'released', closed_at: deps.clock.now(), hold_expires_at: null }).where('id', '=', bookingId).execute();
  if (b.offer_id) await tx.updateTable('booking_offers').set({ status: 'sent' }).where('id', '=', b.offer_id).where('status', '=', 'taken').execute();
  await appendAudit(tx, { type: 'booking.released', actor: { kind: 'system' }, subject: `booking:${bookingId}`, payload: { reason: 'hold_expired' } });
  return 'released';
}
