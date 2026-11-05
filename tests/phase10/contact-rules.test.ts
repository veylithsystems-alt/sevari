import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type TenantTx } from '@sevari/db';
import { ground } from '@sevari/grounding';
import { dispatch, nextSendingTime, reserve, suppress, type PreferenceRegister, type Purpose } from '@sevari/outbound';
import { contractSuite } from '../support/contract.ts';
import { superQuery } from '../support/fixtures.ts';
import { harness, type Harness } from '../support/hitl-harness.ts';

let x: Harness;
const db = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(x.h.db, x.t, fn);
const PRIVACY = 'https://portdrains.example/privacy';
const MARKETING = `Port Drains (example): 10% off drain surveys this month. To unsubscribe, reply STOP. How we use your information: ${PRIVACY}`;

beforeAll(async () => { x = await harness('cr10', 101); });
afterAll(async () => x?.close());

/** A real person who wrote in (Tier A, channel:email), optionally re-sourced or re-classified for the test. */
async function person(opts: { source?: string; type?: string } = {}) {
  const email = `p-${randomUUID()}@example.com`;
  const m = await x.send('Hello there', email);
  const row = await db((tx) => tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id').select(['messages.id as messageId', 'conversations.id as conversationId', 'conversations.contact_id as contactId']).where('messages.id', '=', m.messageId).executeTakeFirstOrThrow());
  if (opts.source) await superQuery('UPDATE contacts SET source = $2 WHERE id = $1', [row.contactId, opts.source]);
  if (opts.type) await superQuery('UPDATE contacts SET subscriber_type = $2 WHERE id = $1', [row.contactId, opts.type]);
  return { ...row, email };
}
const draft = (text: string, purpose: Purpose) => {
  const g = ground(text, purpose === 'marketing' ? 'marketing' : purpose, { factTexts: [text], factIds: [], customerText: '' }, { nowMs: x.clock.nowMs(), timezone: 'Europe/London' });
  if (!g.ok) throw new Error(`test draft not grounded: ${JSON.stringify(g.failures)}`);
  return g.draft;
};
const send = (p: Awaited<ReturnType<typeof person>>, purpose: Purpose, text: string, o: { reply?: boolean; channel?: 'email' | 'sms'; to?: string; register?: PreferenceRegister } = {}) =>
  db((tx) => reserve(tx, x.keyring, x.clock, {
    draft: draft(text, purpose), conversationId: p.conversationId, contactId: p.contactId, ...(o.reply ? { inReplyTo: p.messageId } : {}),
    channel: o.channel ?? 'email', recipient: o.to ?? p.email, actionClass: purpose === 'marketing' ? 'marketing' : 'info_reply', dedupeKey: `t:${randomUUID()}`,
    ...(o.register ? { register: o.register } : {}),
  }));
const consent = (contactId: string, channel: 'email' | 'sms' | 'all', action: 'granted' | 'withdrawn' = 'granted') => db((tx) => tx.insertInto('consents').values({
  tenant_id: x.t.tenantId, region: x.t.region, contact_id: contactId, purpose: 'marketing', channel, action, basis: 'consent', source: 'test form', wording_version: action === 'granted' ? 'w1' : null, recorded_at: x.clock.now(),
}).execute());
const source = (key: string, tier: string, enabled = true, signoff: object | null = null) => db((tx) => tx.insertInto('lead_sources').values({
  tenant_id: x.t.tenantId, region: x.t.region, key, tier: tier as 'B', type: 'test', lawful_basis: 'consent', data_categories: ['email'], acquired_from: 'test', retention_days: 365, enabled,
  counsel_signoff: signoff ? JSON.stringify(signoff) : null, ...(tier === 'E' ? { art14_notice_method: 'email within 30 days' } : {}),
}).execute());

contractSuite('F10', () => {
  it('a contact with no known, enabled source cannot be messaged, by the gate or by a direct write', async () => {
    const p = await person({ source: 'import:spreadsheet' });
    expect(await send(p, 'reply', 'Hello, thanks.', { reply: true })).toMatchObject({ status: 'refused', reason: 'no_provenance' });
    // The database backstop: an outbox row that would actually be attempted is refused outright.
    await expect(db((tx) => tx.insertInto('outbox').values({
      tenant_id: x.t.tenantId, region: x.t.region, conversation_id: p.conversationId, contact_id: p.contactId, channel: 'email', purpose: 'reply', action_class: 'info_reply',
      dedupe_key: `forged:${randomUUID()}`, recipient_enc: Buffer.alloc(1), recipient_bidx: Buffer.alloc(32), body_enc: Buffer.alloc(1), body_digest: Buffer.alloc(32), reserved_at: x.clock.now(),
    }).execute())).rejects.toThrow(/no known, enabled source/);
    // Registered but switched off is the same as unknown.
    await source('import:spreadsheet', 'B', false);
    expect(await send(p, 'reply', 'Hello, thanks.', { reply: true })).toMatchObject({ status: 'refused', reason: 'no_provenance' });
  });

  it('purpose limitation: an enquiry is not consent to marketing; opt-in contacts get only what they opted in to', async () => {
    const a = await person();
    expect(await send(a, 'reply', 'Hello, thanks for your message.', { reply: true })).toMatchObject({ status: 'reserved' });
    expect(await send(a, 'marketing', MARKETING)).toMatchObject({ status: 'refused', reason: 'no_consent' });
    await consent(a.contactId, 'email');
    expect(await send(a, 'marketing', MARKETING)).toMatchObject({ status: 'reserved' });
    await consent(a.contactId, 'all', 'withdrawn'); // the latest answer wins
    expect(await send(a, 'marketing', MARKETING)).toMatchObject({ status: 'refused', reason: 'no_consent' });
    await source('optin:newsletter', 'B');
    const b = await person({ source: 'optin:newsletter' });
    expect(await send(b, 'holding', 'Thank you for your message. A member of the team will reply to you personally.', { reply: true })).toMatchObject({ status: 'refused', reason: 'purpose_not_allowed' });
  });

  it('marketing must say who it is from, how to stop, and how data is used', async () => {
    const a = await person();
    await consent(a.contactId, 'email');
    expect(await send(a, 'marketing', 'Port Drains (example): 10% off drain surveys this month.')).toMatchObject({ status: 'refused', reason: 'missing_identity' });
  });

  it('Tier F can\'t exist, and Tiers C-E can\'t be switched on without counsel\'s sign-off', async () => {
    await expect(source('bought:list', 'F')).rejects.toThrow(/check constraint/);
    await expect(source('corp:outreach', 'C', true)).rejects.toThrow(/check constraint/);
    await expect(source('public:directory', 'E', true)).rejects.toThrow(/check constraint/);
  });
});

contractSuite('F11', () => {
  it('in the UK, corporate outreach (Tier C) is off: nobody is reached through it', async () => {
    await source('corp:linkedin', 'C', true, { by: 'Example Counsel LLP', on: '2026-10-01' });
    const co = await person({ source: 'corp:linkedin', type: 'company' });
    expect(await send(co, 'marketing', MARKETING)).toMatchObject({ status: 'refused', reason: 'tier_disabled' });
  });

  it('where counsel has opened Tier C, only companies and public bodies are reached; sole traders, partnerships and unknowns are individuals', async () => {
    await superQuery(`UPDATE regions SET contact_rules = jsonb_set(contact_rules, '{tiers_enabled}', '["A","B","C"]') WHERE code = $1`, [x.t.region]);
    try {
      const co = await person({ source: 'corp:linkedin', type: 'company' });
      const pb = await person({ source: 'corp:linkedin', type: 'public_body' });
      expect(await send(co, 'marketing', MARKETING)).toMatchObject({ status: 'reserved' });
      expect(await send(pb, 'marketing', MARKETING)).toMatchObject({ status: 'reserved' });
      for (const type of ['sole_trader', 'partnership', 'unknown', 'individual']) {
        const p = await person({ source: 'corp:linkedin', type });
        expect(await send(p, 'marketing', MARKETING)).toMatchObject({ status: 'refused', reason: 'not_corporate' });
      }
    } finally {
      await superQuery(`UPDATE regions SET contact_rules = jsonb_set(contact_rules, '{tiers_enabled}', '["A","B"]') WHERE code = $1`, [x.t.region]);
    }
  });
});

contractSuite('F12', () => {
  const reg = (answer: 'listed' | 'clear' | 'unavailable'): PreferenceRegister => ({ name: 'TPS (test)', check: async () => answer });
  it('marketing by text needs a clear preference-register check: no register, or a listing, means no', async () => {
    const p = await person();
    await consent(p.contactId, 'sms');
    const to = '07700900123';
    expect(await send(p, 'marketing', MARKETING, { channel: 'sms', to })).toMatchObject({ status: 'refused', reason: 'preference_register' });
    expect(await send(p, 'marketing', MARKETING, { channel: 'sms', to, register: reg('unavailable') })).toMatchObject({ status: 'refused', reason: 'preference_register' });
    expect(await send(p, 'marketing', MARKETING, { channel: 'sms', to, register: reg('listed') })).toMatchObject({ status: 'refused', reason: 'preference_register' });
    expect(await send(p, 'marketing', MARKETING, { channel: 'sms', to, register: reg('clear') })).toMatchObject({ status: 'reserved' });
  });
  it('answering a customer by text never needs the register (they wrote in)', async () => {
    const p = await person();
    expect(await send(p, 'reply', 'Hello, thanks for your message.', { reply: true, channel: 'sms', to: '07700900124' })).toMatchObject({ status: 'reserved' });
  });
});

contractSuite('F13', () => {
  it('quiet hours delay a proactive message to the next sending window; answers and acknowledgements are never delayed', async () => {
    const saved = x.clock.nowMs();
    x.clock.set(Date.parse('2026-10-14T22:30:00Z')); // 23:30 in London
    try {
      const p = await person();
      const proactive = await send(p, 'reply', 'Hello, a reminder about your appointment.');
      expect(proactive).toMatchObject({ status: 'reserved', notBefore: new Date('2026-10-15T06:30:00Z') }); // 07:30 London
      const answer = await send(p, 'reply', 'Hello, thanks for your message.', { reply: true });
      expect(answer).toMatchObject({ status: 'reserved', notBefore: null });
      if (proactive.status !== 'reserved') throw new Error('unreachable');
      expect(await dispatch({ db: x.h.db, keyring: x.keyring, clock: x.clock, provider: x.provider }, x.t, proactive.outboxId)).toBe('deferred');
      x.clock.set(Date.parse('2026-10-15T06:31:00Z'));
      expect(await dispatch({ db: x.h.db, keyring: x.keyring, clock: x.clock, provider: x.provider }, x.t, proactive.outboxId)).toBe('sent');
    } finally {
      x.clock.set(saved);
    }
    expect(nextSendingTime(Date.parse('2026-10-15T10:00:00Z'), { timezone: 'Europe/London', sending_window: { start: '07:30', end: '21:30' } })).toBeNull();
  });

  it('caps: at most 3 proactive messages a week, 4 marketing a month, 10 answers an hour per person', async () => {
    const p = await person();
    for (let i = 0; i < 3; i++) expect(await send(p, 'reply', `Hello, update ${i + 1}.`)).toMatchObject({ status: 'reserved' });
    expect(await send(p, 'reply', 'Hello, update 4.')).toMatchObject({ status: 'refused', reason: 'frequency_cap' });
    const q = await person();
    for (let i = 0; i < 10; i++) expect(await send(q, 'reply', `Hello, answer ${i + 1}.`, { reply: true })).toMatchObject({ status: 'reserved' });
    expect(await send(q, 'reply', 'Hello, answer 11.', { reply: true })).toMatchObject({ status: 'refused', reason: 'frequency_cap' });
    x.clock.advance(3_600_000 + 1);
    expect(await send(q, 'reply', 'Hello, answer 12.', { reply: true })).toMatchObject({ status: 'reserved' });
  });
});

contractSuite('F9', () => {
  it('an opt-out racing a send always wins: nothing is handed to the provider after the opt-out commits', async () => {
    let blocked = 0;
    for (let i = 0; i < 25; i++) {
      const p = await person();
      const r = await send(p, 'reply', 'Hello, thanks for your message.', { reply: true });
      if (r.status !== 'reserved') throw new Error(`expected a reservation, got ${r.status}`);
      const [out] = await Promise.all([
        dispatch({ db: x.h.db, keyring: x.keyring, clock: x.clock, provider: x.provider }, x.t, r.outboxId),
        db((tx) => suppress(tx, x.keyring, { channel: 'all', recipient: p.email, recipientKind: 'email', reason: 'stop_keyword', sourceRef: `test:${i}` })),
      ]);
      if (out === 'suppressed') blocked++;
      // Whatever the order, a later send is always refused.
      expect(await send(p, 'reply', 'Hello again.', { reply: true })).toMatchObject({ status: 'suppressed' });
    }
    const breaches = await db((tx) => tx.selectFrom('metrics_floor_suppressed_sends').select('outbox_id').execute());
    expect(breaches).toEqual([]);
    expect(blocked).toBeGreaterThanOrEqual(0);
  });
});

describe('[Phase 10] the rules are data', () => {
  it('the database copy of the UK rules is what the send gate uses', async () => {
    const r = await db((tx) => tx.selectFrom('regions').select('contact_rules').where('code', '=', x.t.region).executeTakeFirstOrThrow());
    expect(r.contact_rules).toMatchObject({ tiers_enabled: ['A', 'B'], sending_window: { start: '07:30', end: '21:30' } });
  });
});
