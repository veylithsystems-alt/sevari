import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type TenantTx } from '@sevari/db';
import { clockTimeIn, matchOfferChoice, slotPhrase } from '@sevari/domain';
import { journeyOf, transitionsOf } from '@sevari/lifecycle';
import { holdSlot, localSlot, runTimer } from '@sevari/worker';
import { contractSuite } from '../support/contract.ts';
import { draftFor, harness, type Harness } from '../support/hitl-harness.ts';

const TZ = 'Europe/London';
/** Every message the (fake) provider accepted, oldest first. */
const sentTexts = () => [...x.provider.accepted.values()].map((v) => v.env.text);

describe('[Phase 9] choosing an offered time (deterministic)', () => {
  const now = Date.parse('2026-10-14T09:00:00Z'); // Wednesday
  const w = (date: string, start: string, end: string) => ({ date, start, end });
  const windows = [w('2026-10-15', '10:00', '12:00'), w('2026-10-15', '14:00', '16:00'), w('2026-10-16', '10:00', '12:00')];
  const pick = (text: string) => matchOfferChoice(text, windows, { nowMs: now, timezone: TZ });
  it('reads clock times the way people write them', () => {
    expect(['10am', 'at 10', '10:00', '10.30am', '2pm', 'at 2', 'half 2', 'midday'].map((x) => clockTimeIn(x))).toEqual(['10:00', '10:00', '10:00', '10:30', '14:00', '14:00', '14:30', '12:00']);
  });
  it('one clear match counts; anything else is ambiguous or none, never a guess', () => {
    expect(pick('Thursday at 10 please')).toEqual({ kind: 'one', index: 0 });
    expect(pick('thursday afternoon works')).toEqual({ kind: 'one', index: 1 });
    expect(pick('The second one')).toEqual({ kind: 'one', index: 1 });
    expect(pick('Friday please')).toEqual({ kind: 'one', index: 2 });
    expect(pick('Thursday is good')).toEqual({ kind: 'ambiguous', candidates: [0, 1] });
    expect(pick('10am')).toEqual({ kind: 'ambiguous', candidates: [0, 2] });
    expect(pick('Yes please')).toMatchObject({ kind: 'ambiguous' });
    expect(pick('None of those work for me, sorry')).toEqual({ kind: 'none' });
    expect(pick('Saturday?')).toEqual({ kind: 'none' });
    expect(pick('How much will it cost?')).toEqual({ kind: 'none' });
    expect(matchOfferChoice('Yes please', [windows[0]!], { nowMs: now, timezone: TZ })).toEqual({ kind: 'one', index: 0 });
  });
});

let x: Harness;
const from = `casey-${randomUUID()}@example.com`;
const db = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(x.h.db, x.t, fn);

beforeAll(async () => {
  x = await harness('book9', 92);
  // Run on the database's clock, so jobs the queue releases are due by the worker's clock too.
  const now = await db(async (tx) => (await tx.selectNoFrom((eb) => eb.fn<Date>('clock_timestamp', []).as('now')).executeTakeFirstOrThrow()).now);
  x.clock.set(new Date(now).getTime());
});
afterAll(async () => x?.close());

const contactOf = (messageId: string) => db(async (tx) => (await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id').select('conversations.contact_id').where('messages.id', '=', messageId).executeTakeFirstOrThrow()).contact_id);
const decideDraft = async (draftId: string, response: 'approve' | 'reject' | 'edit', detail?: string) => {
  const q = await x.question(`draft:${draftId}`);
  expect(q?.status).toBe('open');
  x.clock.advance(5_000);
  const r = await x.answer({ questionId: q!.id, responderId: x.owner, response, digestSeen: q!.digest, ...(detail ? { detail } : {}) });
  await x.drain();
  return r;
};
const offerTimes = async (who: string) => {
  const m = await x.send('Can you come and unblock a drain? CH65 2AB', who);
  const r = await x.process(m.messageId);
  const d = await draftFor(x, r.enquiryId);
  expect(d?.purpose).toBe('reply');
  await decideDraft(d!.id, 'approve');
  const offer = await db((tx) => tx.selectFrom('booking_offers').selectAll().where('draft_id', '=', d!.id).executeTakeFirstOrThrow());
  expect(offer.status).toBe('sent');
  return { offer, contactId: await contactOf(m.messageId) };
};

contractSuite('T-BOOK-2', () => {
  it('times offered → customer picks one → slot held → approved confirmation makes the booking and moves the journey', async () => {
    const { offer, contactId } = await offerTimes(from);
    expect((await db((tx) => journeyOf(tx, contactId)))?.state).toBe('offered');
    const first = offer.windows[0]!;
    const m = await x.send('The first one please', from);
    const r = await x.process(m.messageId);
    const d = await draftFor(x, r.enquiryId);
    expect(d?.action_class).toBe('booking_create');
    const held = await db((tx) => tx.selectFrom('bookings').selectAll().where('draft_id', '=', d!.id).executeTakeFirstOrThrow());
    expect(held).toMatchObject({ status: 'held', starts_at: new Date(first.startMs) });
    // Nothing is booked yet: the journey hasn't moved, and the customer has only had the acknowledgement.
    expect((await db((tx) => journeyOf(tx, contactId)))?.state).toBe('offered');
    await decideDraft(d!.id, 'approve');
    const b = await db((tx) => tx.selectFrom('bookings').selectAll().where('id', '=', held.id).executeTakeFirstOrThrow());
    expect(b).toMatchObject({ status: 'confirmed', hold_expires_at: null });
    expect(sentTexts().at(-1)).toContain(`You are booked in for ${slotPhrase(first)}`);
    const j = await db((tx) => journeyOf(tx, contactId));
    expect(j).toMatchObject({ state: 'booked', anchors: { booking_id: held.id, booking_end: first.endMs } });
    const steps = await db((tx) => transitionsOf(tx, j!.id));
    expect(steps.find((s) => s.event === 'booking_confirmed')).toMatchObject({ action_class: 'booking_create', authority: 'approval' });
    // The job-day check is scheduled for an hour after the booking ends.
    const timer = await db((tx) => tx.selectFrom('lifecycle_timers').select(['event', 'fires_at']).where('subject_id', '=', j!.id).where('status', '=', 'pending').executeTakeFirstOrThrow());
    expect(timer).toEqual({ event: 'job_due', fires_at: new Date(first.endMs + 3_600_000) });
    // A new customer is no longer offered that time.
    const other = await x.send('Can you come and unblock a drain? CH65 2AB', `other-${randomUUID()}@example.com`);
    const ro = await x.process(other.messageId);
    const offered = await db((tx) => tx.selectFrom('booking_offers').select('windows').where('enquiry_id', '=', ro.enquiryId).executeTakeFirstOrThrow());
    expect(offered.windows.some((w) => w.startMs === first.startMs)).toBe(false);
  });

  it('a rejected confirmation frees the slot, and the customer can still choose from their offer', async () => {
    const who = `r-${randomUUID()}@example.com`;
    const { offer, contactId } = await offerTimes(who);
    const m = await x.send('The second one please', who);
    const d = await draftFor(x, (await x.process(m.messageId)).enquiryId);
    await decideDraft(d!.id, 'reject');
    const b = await db((tx) => tx.selectFrom('bookings').select('status').where('draft_id', '=', d!.id).executeTakeFirstOrThrow());
    expect(b.status).toBe('released');
    expect((await db((tx) => tx.selectFrom('booking_offers').select('status').where('id', '=', offer.id).executeTakeFirstOrThrow())).status).toBe('sent');
    expect((await db((tx) => journeyOf(tx, contactId)))?.state).toBe('offered');
  });

  it('an edit that changes the booked time is refused: a confirmation must state the held time exactly', async () => {
    const who = `e-${randomUUID()}@example.com`;
    const { offer } = await offerTimes(who);
    const m = await x.send('The first one please', who);
    const d = await draftFor(x, (await x.process(m.messageId)).enquiryId);
    const wrong = offer.windows[1]!;
    await decideDraft(d!.id, 'edit', `Hello, you are booked in for ${slotPhrase(wrong)}. Port Drains (example)`);
    // The edit names a time that isn't held: it can't be sent as a one-off either.
    const q = await x.question(`draft:${(await draftFor(x, d!.enquiry_id!))!.id}`);
    if (q?.kind === 'clarify_edit' && q.status === 'open') {
      x.clock.advance(5_000);
      const r = await x.answer({ questionId: q.id, responderId: x.owner, response: 'one_off', digestSeen: q.digest });
      expect(r.accepted).toBe(true);
      await x.drain();
    }
    const booked = await db((tx) => tx.selectFrom('bookings').select(['status', 'starts_at']).where('offer_id', '=', offer.id).execute());
    expect(booked.every((b) => b.status !== 'confirmed')).toBe(true);
    expect(sentTexts().some((t) => t.includes(slotPhrase(wrong)) && t.includes('booked in'))).toBe(false);
  });

  it('only an offered time can become a booking: naming another time asks or answers, never books', async () => {
    const who = `n-${randomUUID()}@example.com`;
    await offerTimes(who);
    const m = await x.send('Could you do next Sunday at 7am instead?', who);
    const r = await x.process(m.messageId);
    const d = await draftFor(x, r.enquiryId);
    expect(d?.action_class === 'booking_create').toBe(false);
  });
});

contractSuite('T-BOOK-1', () => {
  it('two customers holding the same slot at the same moment: exactly one gets it', async () => {
    const a = await offerTimes(`a-${randomUUID()}@example.com`);
    const b = await offerTimes(`b-${randomUUID()}@example.com`);
    const w = a.offer.windows.find((aw) => b.offer.windows.some((bw) => bw.startMs === aw.startMs)) ?? a.offer.windows[0]!;
    const slot = localSlot(w.startMs, w.endMs, TZ);
    const results = await Promise.all([a, b, a, b].map((o, i) => db((tx) => holdSlot(tx, {
      contactId: o.contactId, conversationId: o.offer.conversation_id, enquiryId: null, offerId: o.offer.id, service: null, slot, holdUntilMs: x.clock.nowMs() + 3_600_000 + i, replacesId: null,
    }))));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('the database refuses an overlapping booking from any writer, allows back-to-back and another resource, and never moves a slot', async () => {
    const { offer, contactId } = await offerTimes(`d-${randomUUID()}@example.com`);
    const start = new Date(x.clock.nowMs() + 30 * 86_400_000);
    const ins = (s: Date, e: Date, resource = 'default') => db((tx) => tx.insertInto('bookings').values({
      tenant_id: x.t.tenantId, region: x.t.region, contact_id: contactId, offer_id: offer.id, starts_at: s, ends_at: e, status: 'confirmed', confirmed_at: x.clock.now(), resource,
    }).returning('id').executeTakeFirstOrThrow());
    const hour = 3_600_000;
    const first = await ins(start, new Date(start.getTime() + 2 * hour));
    await expect(ins(new Date(start.getTime() + hour), new Date(start.getTime() + 3 * hour))).rejects.toThrow(/conflicting key value violates exclusion constraint/);
    await expect(ins(new Date(start.getTime() + 2 * hour), new Date(start.getTime() + 4 * hour))).resolves.toBeTruthy();
    await expect(ins(start, new Date(start.getTime() + 2 * hour), 'van_2')).resolves.toBeTruthy();
    await expect(db((tx) => tx.updateTable('bookings').set({ starts_at: new Date(start.getTime() + 5 * hour) } as never).where('id', '=', first.id).execute())).rejects.toThrow(/permission denied/);
    await db((tx) => tx.updateTable('bookings').set({ status: 'cancelled', closed_at: x.clock.now() }).where('id', '=', first.id).execute());
    await expect(db((tx) => tx.updateTable('bookings').set({ status: 'confirmed' }).where('id', '=', first.id).execute())).rejects.toThrow(/is closed/);
  });
});

contractSuite('T-BOOK-3', () => {
  let contactId: string;
  let bookingId: string;
  const who = `f-${randomUUID()}@example.com`;
  beforeAll(async () => {
    const o = await offerTimes(who);
    contactId = o.contactId;
    const m = await x.send('The first one please', who);
    const d = await draftFor(x, (await x.process(m.messageId)).enquiryId);
    await decideDraft(d!.id, 'approve');
    bookingId = (await db((tx) => tx.selectFrom('bookings').select('id').where('draft_id', '=', d!.id).executeTakeFirstOrThrow())).id;
  });

  it('"any update?" is answered from the booking itself', async () => {
    const b = await db((tx) => tx.selectFrom('bookings').select(['starts_at', 'ends_at']).where('id', '=', bookingId).executeTakeFirstOrThrow());
    const m = await x.send('Hi, any update on my appointment?', who);
    const r = await x.process(m.messageId);
    expect(r.route).toBe('answer');
    const d = await draftFor(x, r.enquiryId);
    await decideDraft(d!.id, 'approve');
    expect(sentTexts().at(-1)).toContain(`Your booking is for ${slotPhrase(localSlot(b.starts_at.getTime(), b.ends_at.getTime(), TZ))}`);
  });

  it('a cancellation is never automatic; approving it cancels the booking and frees the time', async () => {
    const m = await x.send('Sorry, please cancel my appointment, we sorted it ourselves.', who);
    const r = await x.process(m.messageId);
    const d = await draftFor(x, r.enquiryId);
    expect(d?.action_class).toBe('cancel');
    expect((await db((tx) => tx.selectFrom('bookings').select('status').where('id', '=', bookingId).executeTakeFirstOrThrow())).status).toBe('confirmed');
    await decideDraft(d!.id, 'approve');
    expect((await db((tx) => tx.selectFrom('bookings').select('status').where('id', '=', bookingId).executeTakeFirstOrThrow())).status).toBe('cancelled');
    expect(sentTexts().at(-1)).toMatch(/has been cancelled/);
    expect((await db((tx) => journeyOf(tx, contactId)))?.state).toBe('cancelled');
  });

  it('after the job day the owner is asked how it went, and the answer closes the booking', async () => {
    const who2 = `g-${randomUUID()}@example.com`;
    const o = await offerTimes(who2);
    const m = await x.send('The first one please', who2);
    const d = await draftFor(x, (await x.process(m.messageId)).enquiryId);
    await decideDraft(d!.id, 'approve');
    const j = await db((tx) => journeyOf(tx, o.contactId));
    const timer = await db((tx) => tx.selectFrom('lifecycle_timers').select(['id', 'fires_at']).where('subject_id', '=', j!.id).where('status', '=', 'pending').executeTakeFirstOrThrow());
    const saved = x.clock.nowMs();
    x.clock.set(timer.fires_at.getTime() + 1_000);
    expect(await db((tx) => runTimer(x, tx, timer.id))).toBe('moved');
    await x.drain();
    const q = await x.question(`lifecycle:${j!.id}`);
    expect(q).toMatchObject({ kind: 'lifecycle_step', status: 'open' });
    x.clock.advance(5_000);
    expect((await x.answer({ questionId: q!.id, responderId: x.owner, response: 'job_done', digestSeen: q!.digest })).accepted).toBe(true);
    await x.drain();
    expect((await db((tx) => journeyOf(tx, o.contactId)))?.state).toBe('completed');
    expect((await db((tx) => tx.selectFrom('bookings').select('status').where('draft_id', '=', d!.id).executeTakeFirstOrThrow())).status).toBe('completed');
    x.clock.set(saved);
  });
});
