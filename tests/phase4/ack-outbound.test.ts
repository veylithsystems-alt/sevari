import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signWebhook, signedWebhookAdapter, smsAdapter, FakeSmsProvider, webformAdapter } from '@sevari/channels';
import { FixedClock } from '@sevari/clock';
import { LocalKeyFileKms, TenantKeyring } from '@sevari/crypto';
import { sql, withTenant, type DbHandle } from '@sevari/db';
import { regionCode, type TenantScope } from '@sevari/domain';
import { ground } from '@sevari/grounding';
import { createEndpoint, receiveInbound, type IntakeDeps } from '@sevari/intake';
import { confirmRecord, proposeRecord } from '@sevari/knowledge';
import { dispatch, FakeProvider, reconcile, reserve, suppress } from '@sevari/outbound';
import { render, smsEncoding } from '@sevari/templates';
import { sendAck } from '@sevari/worker';
import { KNOWLEDGE } from '../../eval/fixtures/knowledge.ts';
import { appDb, newTenant } from '../support/fixtures.ts';

const clock = new FixedClock(Date.parse('2026-10-14T09:00:00Z'));
const keyring = new TenantKeyring(LocalKeyFileKms.fromKey(Buffer.alloc(32, 6)));

async function seed(h: DbHandle, s: TenantScope, withBusiness = true) {
  await withTenant(h.db, s, async (tx) => {
    await keyring.provision(tx);
    const k = KNOWLEDGE['drainage']!;
    for (const f of [...(withBusiness ? [k.business!] : []), k.hours!, ...k.areas]) {
      const r = await proposeRecord(tx, keyring, { body: f.body, source: 'onboarding_interview', proposedBy: 'user:owner' });
      await confirmRecord(tx, clock, { id: r.id, confirmedBy: 'user:owner' });
    }
  });
  return withTenant(h.db, s, (tx) => createEndpoint(tx, keyring, { channel: 'email', lawfulBasis: 'legitimate_interests_enquiry_response', purpose: 'enquiries' }, 'user:owner'));
}

describe('[Phase 4] deterministic acknowledgement (§5.2)', () => {
  let h: DbHandle;
  let t: TenantScope;
  let ep: { publicId: string; secret: Buffer | null };
  let intake: IntakeDeps;
  const provider = new FakeProvider();

  beforeAll(async () => {
    h = appDb();
    t = await newTenant(h, 'uk', 'Port Drains');
    ep = await seed(h, t);
    intake = { db: h.db, keyring, clock, cellRegion: regionCode('uk'), cellUrls: {}, adapters: { email: signedWebhookAdapter('email'), webform: webformAdapter, sms: smsAdapter(FakeSmsProvider) } };
  });
  afterAll(async () => h.close());

  const inbound = async (text: string, from = `c-${randomUUID()}@example.com`) => {
    const body = Buffer.from(JSON.stringify({ id: randomUUID(), from: { email: from }, text }));
    const ts = Math.floor(clock.nowMs() / 1000);
    const r = await receiveInbound(intake, { channel: 'email', publicId: ep.publicId, raw: { body, headers: { 'x-sevari-timestamp': String(ts), 'x-sevari-signature': signWebhook(ep.secret!, ts, body) }, url: 'x' } });
    if (r.status !== 'accepted') throw new Error(JSON.stringify(r));
    return { id: r.messageId, from };
  };
  const deps = () => ({ db: h.db, keyring, clock, provider });
  const lastTo = (to: string) => [...provider.accepted.values()].filter((v) => v.env.to === to).map((v) => v.env.text);

  it('sends one acknowledgement with the business name, reply-time promise, privacy link and automation notice', async () => {
    const m = await inbound('My drain is blocked, can you help?');
    expect(await sendAck(deps(), t, m.id)).toBe('sent');
    const [text] = lastTo(m.from);
    expect(text).toContain('Port Drains (example)');
    expect(text).toContain('within 2 working hours');
    expect(text).toContain('https://example.com/privacy');
    expect(text).toContain('This is an automatic reply.');
  });

  it('never acknowledges twice for the same message, even if the job re-runs', async () => {
    const m = await inbound('Blocked toilet please help');
    await sendAck(deps(), t, m.id);
    expect(await sendAck(deps(), t, m.id)).toBe('already');
    expect(lastTo(m.from)).toHaveLength(1);
  });

  it('STOP: suppresses first, sends nothing, and later messages to that person are blocked (§50.3, F39 groundwork)', async () => {
    const from = `stop-${randomUUID()}@example.com`;
    const s = await inbound('STOP', from);
    expect(await sendAck(deps(), t, s.id)).toBe('opted_out');
    expect(lastTo(from)).toEqual([]);
    const next = await inbound('Actually my drain is blocked again', from);
    expect(await sendAck(deps(), t, next.id)).toBe('suppressed');
    expect(lastTo(from)).toEqual([]);
  });

  it('risk to life gets the deterministic safety message (§42)', async () => {
    const m = await inbound('There is water pouring onto the light fitting in the kitchen!');
    expect(await sendAck(deps(), t, m.id)).toBe('sent');
    expect(lastTo(m.from)[0]).toContain('call 999');
  });

  it('a legal threat gets a holding acknowledgement only (§20.2, T-CMP-1 groundwork)', async () => {
    const m = await inbound('Fix this or I am taking legal action through my solicitor.');
    await sendAck(deps(), t, m.id);
    const text = lastTo(m.from)[0]!;
    expect(text).toContain('will reply to you personally');
    expect(text).not.toMatch(/£|price|quote|sorry/i);
  });

  it('with no confirmed business record: no send, a reply record says why (§50.3)', async () => {
    const bare = await newTenant(h, 'uk', 'Bare Ltd');
    const bareEp = await seed(h, bare, false);
    const body = Buffer.from(JSON.stringify({ id: randomUUID(), from: { email: 'x@example.com' }, text: 'hello' }));
    const ts = Math.floor(clock.nowMs() / 1000);
    const r = await receiveInbound(intake, { channel: 'email', publicId: bareEp.publicId, raw: { body, headers: { 'x-sevari-timestamp': String(ts), 'x-sevari-signature': signWebhook(bareEp.secret!, ts, body) }, url: 'x' } });
    const id = r.status === 'accepted' ? r.messageId : '';
    expect(await sendAck(deps(), bare, id)).toBe('blocked');
    const rec = await withTenant(h.db, bare, (tx) => tx.selectFrom('reply_records').select(['send_result', 'facts_missing']).where('inbound_message_id', '=', id).executeTakeFirst());
    expect(rec).toMatchObject({ send_result: 'blocked_template', facts_missing: ['template:no confirmed business record'] });
  });

  it('reply records carry timings and citations, never content', async () => {
    const m = await inbound('Need a drain survey');
    await sendAck(deps(), t, m.id);
    const rec = await withTenant(h.db, t, (tx) => tx.selectFrom('reply_records').selectAll().where('inbound_message_id', '=', m.id).executeTakeFirstOrThrow());
    expect(rec).toMatchObject({ generator: 'template', grounding_ok: true, autonomy_decision: 'auto_ack', send_result: 'sent' });
    expect(rec.latency_ms).toHaveProperty('received_to_provider_accepted');
    expect(rec.facts_used[0]).toMatch(/@1$/);
    expect(JSON.stringify(rec)).not.toContain('survey');
  });
});

describe('[Phase 4] outbox safety (§5.2, Part J §66 groundwork for F46–F50)', () => {
  let h: DbHandle;
  let t: TenantScope;
  let contactId: string;
  let conversationId: string;
  beforeAll(async () => {
    h = appDb();
    t = await newTenant(h, 'uk', 'Outbox Ltd');
    await withTenant(h.db, t, (tx) => keyring.provision(tx));
    ({ contactId, conversationId } = await withTenant(h.db, t, async (tx) => {
      const c = await tx.insertInto('contacts').values({ tenant_id: t.tenantId, region: t.region, source: 'test', lawful_basis: 'test', captured_at: clock.now(), captured_by: 'test' }).returning('id').executeTakeFirstOrThrow();
      const v = await tx.insertInto('conversations').values({ tenant_id: t.tenantId, region: t.region, contact_id: c.id }).returning('id').executeTakeFirstOrThrow();
      return { contactId: c.id, conversationId: v.id };
    }));
  });
  afterAll(async () => h.close());

  const draft = (text = 'Thanks, we have your message.') => {
    const g = ground(text, 'ack', { factTexts: [text], factIds: ['kb@1'], customerText: '' }, { nowMs: clock.nowMs(), timezone: 'Europe/London' });
    if (!g.ok) throw new Error('fixture draft not grounded');
    return g.draft;
  };
  const reserveOne = (to: string, actionClass = 'ack') => withTenant(h.db, t, (tx) => reserve(tx, keyring, clock, {
    draft: draft(), conversationId, contactId, channel: 'email', recipient: to, actionClass, dedupeKey: randomUUID(),
  }));

  it('a crash after the provider accepted (response lost) is reconciled to sent, with one delivery', async () => {
    const p = new FakeProvider();
    p.script.push('timeout_after_accept');
    const r = await reserveOne('a1@example.com');
    if (r.status !== 'reserved') throw new Error();
    expect(await dispatch({ db: h.db, keyring, clock, provider: p }, t, r.outboxId)).toBe('ambiguous');
    expect(await reconcile({ db: h.db, keyring, clock, provider: p }, t, r.outboxId)).toBe('confirmed_sent');
    expect(p.deliveries).toBe(1);
  });

  it('a timeout before the provider received it is retried safely and delivered once', async () => {
    const p = new FakeProvider();
    p.script.push('timeout_before_accept');
    const r = await reserveOne('a2@example.com');
    if (r.status !== 'reserved') throw new Error();
    expect(await dispatch({ db: h.db, keyring, clock, provider: p }, t, r.outboxId)).toBe('ambiguous');
    expect(await reconcile({ db: h.db, keyring, clock, provider: p }, t, r.outboxId)).toBe('requeued');
    expect(await dispatch({ db: h.db, keyring, clock, provider: p }, t, r.outboxId)).toBe('sent');
    expect(p.deliveries).toBe(1);
  });

  it('a consequential class is never retried automatically when the outcome is unknown', async () => {
    const p = new FakeProvider();
    p.script.push('timeout_before_accept');
    const r = await reserveOne('a3@example.com', 'payment_request');
    if (r.status !== 'reserved') throw new Error();
    await dispatch({ db: h.db, keyring, clock, provider: p }, t, r.outboxId);
    expect(await reconcile({ db: h.db, keyring, clock, provider: p }, t, r.outboxId)).toBe('needs_human');
    expect(await dispatch({ db: h.db, keyring, clock, provider: p }, t, r.outboxId)).toBe('not_dispatchable');
    expect(p.deliveries).toBe(0);
  });

  it('an opt-out that lands between reservation and dispatch wins', async () => {
    const p = new FakeProvider();
    const r = await reserveOne('late-stop@example.com');
    if (r.status !== 'reserved') throw new Error();
    await withTenant(h.db, t, (tx) => suppress(tx, keyring, { channel: 'email', recipient: 'late-stop@example.com', recipientKind: 'email', reason: 'opt_out_request', sourceRef: 'test' }));
    expect(await dispatch({ db: h.db, keyring, clock, provider: p }, t, r.outboxId)).toBe('suppressed');
    expect(p.deliveries).toBe(0);
  });

  it('a provider-side block suppresses the recipient for the future', async () => {
    const p = new FakeProvider();
    p.script.push('block');
    const r = await reserveOne('blocked@example.com');
    if (r.status !== 'reserved') throw new Error();
    expect(await dispatch({ db: h.db, keyring, clock, provider: p }, t, r.outboxId)).toBe('failed');
    expect((await reserveOne('blocked@example.com')).status).toBe('suppressed');
  });

  it('outbound content is immutable after reservation (approval digests bind to it, §7.1)', async () => {
    const r = await reserveOne('imm@example.com');
    await expect(withTenant(h.db, t, (tx) => sql`UPDATE outbox SET body_enc = '\\x00' WHERE id = ${r.outboxId}`.execute(tx))).rejects.toThrow(/permission denied/);
    await expect(withTenant(h.db, t, (tx) => sql`UPDATE outbox SET recipient_bidx = '\\x00' WHERE id = ${r.outboxId}`.execute(tx))).rejects.toThrow(/permission denied/);
  });

  it('only a grounded draft can be reserved (INV-5)', async () => {
    await expect(withTenant(h.db, t, (tx) => reserve(tx, keyring, clock, {
      draft: { text: 'forged', purpose: 'reply', claims: [], factsUsed: [] } as never, conversationId, contactId, channel: 'email', recipient: 'f@example.com', actionClass: 'reply', dedupeKey: randomUUID(),
    }))).rejects.toThrow(/grounded/);
  });
});

describe('[Phase 4] templates', () => {
  const v = { business: 'Port Drains', replyTime: 'within 2 working hours', privacyUrl: 'https://example.com/privacy', discloseAutomation: true, safetyMessage: 'If anyone is in danger, call 999 now.', question: 'Could you send your postcode?' };
  it('every SMS template fits in GSM-7 within 2 segments (§60.2)', () => {
    for (const id of ['ack', 'holding', 'safety', 'clarify'] as const) {
      const r = render(id, 'sms', v);
      expect(r.ok, id).toBe(true);
      if (r.ok) expect(smsEncoding(r.text)).toMatchObject({ encoding: 'GSM-7' });
    }
  });
  it('a curly apostrophe in a business name is straightened rather than tipping SMS into UCS-2', () => {
    const r = render('ack', 'sms', { ...v, business: 'Dan’s Drains' });
    expect(r.ok && r.text.includes("Dan's Drains")).toBe(true);
  });
  it('non-GSM characters and over-long names block the SMS instead of sending', () => {
    expect(render('ack', 'sms', { ...v, business: 'Drains 🚽' })).toMatchObject({ ok: false });
    expect(render('ack', 'sms', { ...v, business: 'A'.repeat(41) })).toMatchObject({ ok: false });
  });
  it('a missing value blocks the send (§50.3)', () => {
    expect(render('ack', 'email', { ...v, replyTime: '' })).toEqual({ ok: false, reason: 'missing value: replyTime' });
  });
  it('SMS templates include STOP and the privacy link', () => {
    const r = render('ack', 'sms', v);
    expect(r.ok && r.text).toMatch(/Reply STOP to opt out\. Privacy: https:\/\/example\.com\/privacy$/);
  });
});
