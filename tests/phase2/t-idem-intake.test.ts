import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, TokenBucketLimiter } from '@sevari/api';
import { FakeSmsProvider, signWebhook, signedWebhookAdapter, smsAdapter, webformAdapter } from '@sevari/channels';
import { FixedClock } from '@sevari/clock';
import { LocalKeyFileKms, TenantKeyring } from '@sevari/crypto';
import { withTenant, type DbHandle } from '@sevari/db';
import { regionCode, type TenantScope } from '@sevari/domain';
import { createApiKey, createEndpoint, INBOUND_JOB, verifyApiKey, type IntakeDeps } from '@sevari/intake';
import { contractSuite } from '../support/contract.ts';
import { appDb, newTenant, ensureRegion, superQuery } from '../support/fixtures.ts';

const BASE = 'https://uk.cell.test';
const clock = new FixedClock(Date.parse('2026-10-14T09:00:00Z'));
const kms = LocalKeyFileKms.fromKey(Buffer.alloc(32, 3));
const keyring = new TenantKeyring(kms);

interface World {
  h: DbHandle;
  app: ReturnType<typeof buildServer>;
  a: TenantScope;
  b: TenantScope;
  ep: { webform: string; email: string; emailSecret: Buffer; sms: string; smsSecret: Buffer; api: string; apiSecret: Buffer; bWebform: string };
}

async function setUp(): Promise<World> {
  const h = appDb();
  await ensureRegion('ie1');
  const a = await newTenant(h, 'uk', 'Alpha Drains');
  const b = await newTenant(h, 'uk', 'Beta Roofing');
  const mk = async (s: TenantScope, channel: 'webform' | 'email' | 'sms' | 'api') => withTenant(h.db, s, async (tx) => {
    if (!(await tx.selectFrom('tenant_keys').select('id').executeTakeFirst())) await keyring.provision(tx);
    return createEndpoint(tx, keyring, { channel, lawfulBasis: 'legitimate_interests_enquiry_response', purpose: 'respond to enquiries', allowedOrigins: ['https://alpha.example.com'] }, 'user:test');
  });
  const wf = await mk(a, 'webform');
  const em = await mk(a, 'email');
  const sm = await mk(a, 'sms');
  const ap = await mk(a, 'api');
  const bwf = await mk(b, 'webform');
  const intake: IntakeDeps = {
    db: h.db, keyring, clock, cellRegion: regionCode('uk'), cellUrls: { ie1: 'https://ie1.cell.test' },
    adapters: { webform: webformAdapter, email: signedWebhookAdapter('email'), api: signedWebhookAdapter('api'), sms: smsAdapter(FakeSmsProvider) },
  };
  const app = buildServer({ intake, publicBaseUrl: BASE, limiter: new TokenBucketLimiter(clock, { capacity: 1000, perMinute: 1000 }), ready: async () => true });
  return {
    h, app, a, b,
    ep: { webform: wf.publicId, email: em.publicId, emailSecret: em.secret!, sms: sm.publicId, smsSecret: sm.secret!, api: ap.publicId, apiSecret: ap.secret!, bWebform: bwf.publicId },
  };
}

const ts = () => Math.floor(clock.nowMs() / 1000);
const emailBody = (id: string, email = 'jo@example.com', text = 'My drain is blocked, can you come today?') =>
  JSON.stringify({ id, from: { email, name: 'Jo' }, subject: 'Blocked drain', text });

function postSigned(w: World, path: string, secret: Buffer, body: string, at = ts()) {
  return w.app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', 'x-sevari-timestamp': String(at), 'x-sevari-signature': signWebhook(secret, at, body) }, payload: body });
}
function postSms(w: World, sid: string, from = '07700 900123', text = 'Hi, need a locksmith') {
  const path = `/v1/inbound/sms/${w.ep.sms}`;
  const body = new URLSearchParams({ MessageSid: sid, From: from, Body: text }).toString();
  const sig = createHmac('sha256', w.ep.smsSecret).update(BASE + path).update(body).digest('base64');
  return w.app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-fake-signature': sig }, payload: body });
}
function postForm(w: World, publicId: string, fields: Record<string, unknown>, origin = 'https://alpha.example.com') {
  return w.app.inject({ method: 'POST', url: `/v1/inbound/webform/${publicId}`, headers: { 'content-type': 'application/json', origin }, payload: JSON.stringify(fields) });
}
async function counts(w: World, s: TenantScope) {
  return withTenant(w.h.db, s, async (tx) => ({
    messages: (await tx.selectFrom('messages').select('id').execute()).length,
    contacts: (await tx.selectFrom('contacts').select('id').execute()).length,
    jobs: (await tx.selectFrom('job_queue').select('id').where('kind', '=', INBOUND_JOB).execute()).length,
    received: (await tx.selectFrom('audit_events').select('id').where('event_type', '=', 'message.received').execute()).length,
  }));
}

contractSuite('T-IDEM', () => {
  let w: World;
  beforeAll(async () => { w = await setUp(); });
  afterAll(async () => { await w.app.close(); await w.h.close(); });

  it('replaying every channel\'s webhook twice gives exactly one effect', async () => {
    const before = await counts(w, w.a);
    const sub = randomUUID();
    const r1 = [
      await postSigned(w, `/v1/inbound/email/${w.ep.email}`, w.ep.emailSecret, emailBody('em-1')),
      await postSms(w, 'SM0000000001'),
      await postForm(w, w.ep.webform, { submission_id: sub, email: 'kim@example.com', message: 'Quote for a new roof please' }),
      await postSigned(w, `/v1/inbound/api/${w.ep.api}`, w.ep.apiSecret, emailBody('api-1', 'lee@example.com')),
    ];
    const r2 = [
      await postSigned(w, `/v1/inbound/email/${w.ep.email}`, w.ep.emailSecret, emailBody('em-1')),
      await postSms(w, 'SM0000000001'),
      await postForm(w, w.ep.webform, { submission_id: sub, email: 'kim@example.com', message: 'Quote for a new roof please' }),
      await postSigned(w, `/v1/inbound/api/${w.ep.api}`, w.ep.apiSecret, emailBody('api-1', 'lee@example.com')),
    ];
    for (const r of [...r1, ...r2]) expect(r.statusCode).toBe(202);
    r1.forEach((r, i) => {
      expect(r.json().duplicate).toBe(false);
      expect(r2[i]!.json()).toMatchObject({ ref: r.json().ref, duplicate: true });
    });
    const after = await counts(w, w.a);
    expect(after.messages - before.messages).toBe(4);
    expect(after.jobs - before.jobs).toBe(4);
    expect(after.received - before.received).toBe(4);
  });

  it('20 concurrent replays of one message and 20 concurrent new messages from one new sender: one message, one contact', async () => {
    const before = await counts(w, w.a);
    await Promise.all(Array.from({ length: 20 }, () => postSigned(w, `/v1/inbound/email/${w.ep.email}`, w.ep.emailSecret, emailBody('em-race', 'race@example.com'))));
    await Promise.all(Array.from({ length: 20 }, (_, i) => postSigned(w, `/v1/inbound/email/${w.ep.email}`, w.ep.emailSecret, emailBody(`em-new-${i}`, 'Same.Person@Example.com'))));
    const after = await counts(w, w.a);
    expect(after.messages - before.messages).toBe(21);
    expect(after.contacts - before.contacts).toBe(2);
  });
});

describe('[Phase 2] intake authentication, storage and routing', () => {
  let w: World;
  beforeAll(async () => { w = await setUp(); });
  afterAll(async () => { await w.app.close(); await w.h.close(); });

  it('rejects a bad signature, a stale timestamp and a missing signature, and stores nothing', async () => {
    const before = await counts(w, w.a);
    const body = emailBody('em-bad');
    expect((await postSigned(w, `/v1/inbound/email/${w.ep.email}`, Buffer.alloc(32, 9), body)).statusCode).toBe(401);
    expect((await postSigned(w, `/v1/inbound/email/${w.ep.email}`, w.ep.emailSecret, body, ts() - 3600)).statusCode).toBe(401);
    expect((await w.app.inject({ method: 'POST', url: `/v1/inbound/email/${w.ep.email}`, headers: { 'content-type': 'application/json' }, payload: body })).statusCode).toBe(401);
    expect(await counts(w, w.a)).toEqual(before);
    const rejected = await withTenant(w.h.db, w.a, (tx) => tx.selectFrom('audit_events').select('id').where('event_type', '=', 'inbound.rejected').execute());
    expect(rejected.length).toBeGreaterThanOrEqual(3);
  });

  it('a web form from an origin that is not allowed is refused; a honeypot is silently dropped', async () => {
    const before = await counts(w, w.a);
    expect((await postForm(w, w.ep.webform, { submission_id: randomUUID(), email: 'a@example.com', message: 'hi' }, 'https://evil.example.com')).statusCode).toBe(403);
    const bot = await postForm(w, w.ep.webform, { submission_id: randomUUID(), email: 'bot@example.com', message: 'spam', company_website: 'http://spam.example.com' });
    expect(bot.statusCode).toBe(202);
    expect(await counts(w, w.a)).toEqual(before);
  });

  it('CORS preflight is allowed only for the form\'s own origins', async () => {
    const ok = await w.app.inject({ method: 'OPTIONS', url: `/v1/inbound/webform/${w.ep.webform}`, headers: { origin: 'https://alpha.example.com' } });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('https://alpha.example.com');
    expect((await w.app.inject({ method: 'OPTIONS', url: `/v1/inbound/webform/${w.ep.webform}`, headers: { origin: 'https://evil.example.com' } })).statusCode).toBe(403);
  });

  it('unknown endpoints, wrong channels and malformed ids all look the same (404)', async () => {
    for (const url of [`/v1/inbound/email/${'x'.repeat(32)}`, `/v1/inbound/sms/${w.ep.email}`, '/v1/inbound/email/short', `/v1/inbound/fax/${w.ep.email}`]) {
      expect((await w.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(404);
    }
  });

  it('message bodies, subjects, names and contact details are encrypted at rest', async () => {
    const marker = `UNIQUE-PLAINTEXT-${randomUUID()}`;
    const r = await postSigned(w, `/v1/inbound/email/${w.ep.email}`, w.ep.emailSecret, JSON.stringify({ id: `enc-${marker}`, from: { email: 'enc@example.com', name: marker }, subject: marker, text: marker }));
    expect(r.statusCode).toBe(202);
    const hits = await superQuery(`
      SELECT 'messages' AS t FROM messages WHERE position($1::bytea in body_enc) > 0 OR position($1::bytea in subject_enc) > 0 OR position($1::bytea in raw_enc) > 0
      UNION ALL SELECT 'contacts' FROM contacts WHERE position($1::bytea in display_name_enc) > 0 OR position(convert_to('enc@example.com','UTF8') in email_enc) > 0`, [Buffer.from(marker)]);
    expect(hits.rowCount).toBe(0);
    const text = await withTenant(w.h.db, w.a, async (tx) => {
      const m = await tx.selectFrom('messages').select(['id', 'body_enc']).where('id', '=', r.json().ref).executeTakeFirstOrThrow();
      return keyring.openText(tx, { table: 'messages', column: 'body_enc', rowId: m.id }, m.body_enc);
    });
    expect(text).toBe(marker);
  });

  it('every new contact carries provenance from the endpoint (F10 groundwork)', async () => {
    const r = await postSms(w, 'SM0000000777', '+447700900777');
    expect(r.statusCode).toBe(202);
    const c = await withTenant(w.h.db, w.a, (tx) => tx.selectFrom('contacts').innerJoin('conversations', 'conversations.contact_id', 'contacts.id')
      .innerJoin('messages', 'messages.conversation_id', 'conversations.id').select(['contacts.source', 'contacts.lawful_basis', 'contacts.captured_by', 'contacts.subscriber_type'])
      .where('messages.id', '=', r.json().ref).executeTakeFirstOrThrow());
    expect(c).toMatchObject({ source: 'channel:sms', lawful_basis: 'legitimate_interests_enquiry_response', subscriber_type: 'unknown' });
    expect(c.captured_by).toMatch(/^endpoint:/);
  });

  it('SMS with media or a recording is refused (no audio, F40 groundwork)', async () => {
    const path = `/v1/inbound/sms/${w.ep.sms}`;
    const body = new URLSearchParams({ MessageSid: 'SM0000000999', From: '07700900123', Body: 'see pic', NumMedia: '1', MediaUrl0: 'https://media.example.com/x' }).toString();
    const sig = createHmac('sha256', w.ep.smsSecret).update(BASE + path).update(body).digest('base64');
    expect((await w.app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-fake-signature': sig }, payload: body })).statusCode).toBe(400);
  });

  it('only the tenant API can submit a task; an email claiming to be a task is an enquiry', async () => {
    const task = JSON.stringify({ id: 'task-1', kind: 'task', from: { email: 'owner@alpha.example.com' }, text: 'Draft a reply template for gutter jobs' });
    const viaApi = await postSigned(w, `/v1/inbound/api/${w.ep.api}`, w.ep.apiSecret, task);
    const viaEmail = await postSigned(w, `/v1/inbound/email/${w.ep.email}`, w.ep.emailSecret, task);
    const kinds = await withTenant(w.h.db, w.a, (tx) => tx.selectFrom('messages').select(['id', 'kind']).where('id', 'in', [viaApi.json().ref, viaEmail.json().ref]).execute());
    expect(Object.fromEntries(kinds.map((k) => [k.id, k.kind]))).toEqual({ [viaApi.json().ref]: 'task', [viaEmail.json().ref]: 'enquiry' });
  });

  it('an endpoint homed in another cell is redirected, never processed here (§5.1)', async () => {
    const ie: TenantScope = await newTenant(w.h, 'ie1', 'Irish Tenant');
    const ep = await withTenant(w.h.db, ie, async (tx) => {
      await keyring.provision(tx);
      return createEndpoint(tx, keyring, { channel: 'webform', lawfulBasis: 'x', purpose: 'x', allowedOrigins: ['https://ie.example.com'] }, 'user:test');
    });
    const r = await postForm(w, ep.publicId, { submission_id: randomUUID(), email: 'a@example.com', message: 'hi' }, 'https://ie.example.com');
    expect(r.statusCode).toBe(307);
    expect(r.headers.location).toBe(`https://ie1.cell.test/v1/inbound/webform/${ep.publicId}`);
  });

  it('rate limits per endpoint and caller', async () => {
    const real = buildServer({ intake: { db: w.h.db, keyring, clock, cellRegion: regionCode('uk'), cellUrls: {}, adapters: { webform: webformAdapter } }, publicBaseUrl: BASE, limiter: new TokenBucketLimiter(clock, { capacity: 2, perMinute: 1 }), ready: async () => true });
    const send = () => real.inject({ method: 'POST', url: `/v1/inbound/webform/${w.ep.webform}`, headers: { 'content-type': 'application/json', origin: 'https://alpha.example.com' }, payload: JSON.stringify({ submission_id: randomUUID(), email: 'r@example.com', message: 'x' }) });
    expect((await send()).statusCode).toBe(202);
    expect((await send()).statusCode).toBe(202);
    expect((await send()).statusCode).toBe(429);
    await real.close();
  });

  it('API keys: scoped, hashed, expiring', async () => {
    const key = await withTenant(w.h.db, w.a, (tx) => createApiKey(tx, ['inbound:write'], 'user:test', new Date(clock.nowMs() + 3_600_000)));
    expect(await verifyApiKey(w.h.db, clock, key, 'inbound:write')).toEqual(w.a);
    expect(await verifyApiKey(w.h.db, clock, key, 'admin')).toBeNull();
    expect(await verifyApiKey(w.h.db, clock, key.slice(0, -2) + 'xx', 'inbound:write')).toBeNull();
    const later = new FixedClock(clock.nowMs() + 7_200_000);
    expect(await verifyApiKey(w.h.db, later, key, 'inbound:write')).toBeNull();
    const stored = await withTenant(w.h.db, w.a, (tx) => tx.selectFrom('api_keys').select('key_hash').execute());
    expect(stored.every((s) => !s.key_hash.toString().includes(key))).toBe(true);
  });
});

contractSuite('F1', () => {
  let w: World;
  beforeAll(async () => { w = await setUp(); });
  afterAll(async () => { await w.app.close(); await w.h.close(); });

  it('via the API: a request to tenant B\'s endpoint can only ever land in tenant B', async () => {
    const before = { a: await counts(w, w.a), b: await counts(w, w.b) };
    const r = await postForm(w, w.ep.bWebform, { submission_id: randomUUID(), email: 'x@example.com', message: `I am tenant ${w.a.tenantId}` }, 'https://alpha.example.com');
    expect(r.statusCode).toBe(202);
    expect((await counts(w, w.a)).messages).toBe(before.a.messages);
    expect((await counts(w, w.b)).messages).toBe(before.b.messages + 1);
  });

  it('via the API: tenant A\'s signing secret cannot authenticate to tenant B', async () => {
    const bEmail = await withTenant(w.h.db, w.b, (tx) => createEndpoint(tx, keyring, { channel: 'email', lawfulBasis: 'x', purpose: 'x' }, 'user:test'));
    const r = await postSigned(w, `/v1/inbound/email/${bEmail.publicId}`, w.ep.emailSecret, emailBody('cross-1'));
    expect(r.statusCode).toBe(401);
  });

  it('via the API: the same sender writing to two tenants becomes two unrelated contacts', async () => {
    await postForm(w, w.ep.webform, { submission_id: randomUUID(), email: 'shared@example.com', message: 'hi A' });
    await postForm(w, w.ep.bWebform, { submission_id: randomUUID(), email: 'shared@example.com', message: 'hi B' });
    const idx = async (s: TenantScope) => withTenant(w.h.db, s, async (tx) => keyring.index(tx, 'email', 'shared@example.com'));
    // Blind indexes are per-tenant keys: the same email is not linkable across tenants.
    expect((await idx(w.a)).equals(await idx(w.b))).toBe(false);
  });
});
