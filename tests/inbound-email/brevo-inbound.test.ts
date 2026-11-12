import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, TokenBucketLimiter } from '@sevari/api';
import { BrevoInboundItem, dropReason, emailAdapter, signedWebhookAdapter } from '@sevari/channels';
import { withTenant } from '@sevari/db';
import { createUserToken } from '@sevari/identity';
import { createEndpoint } from '@sevari/intake';
import { harness, type Harness } from '../support/hitl-harness.ts';

/** Customers emailing a business, received through Brevo (approved processor) and routed by address. */
const TOKEN = 'brevo-inbound-test-token-0123456789abcdef';
const DOMAIN = 'in.sevari.example';
const ADDRESS = `test-drains-${randomUUID().slice(0, 6)}@${DOMAIN}`;
let x: Harness;
let app: ReturnType<typeof buildServer>;

const email = (over: Record<string, unknown> = {}) => ({
  Uuid: [randomUUID()], MessageId: `<${randomUUID()}@mail.example>`, From: { Address: 'sam@customer.example', Name: 'Sam Customer' },
  To: [{ Address: ADDRESS }], Recipients: [{ Address: ADDRESS }], Subject: 'Blocked drain',
  RawTextBody: 'Hi, my kitchen drain is blocked. How much to unblock it? CH65 2AB\n\n> earlier quoted text', ExtractedMarkdownMessage: 'Hi, my kitchen drain is blocked. How much to unblock it? CH65 2AB',
  Spam: { Score: 0.4 }, Headers: { 'Message-ID': '<x@mail.example>' }, ...over,
});
const post = (body: unknown, token = TOKEN) => app.inject({ method: 'POST', url: '/v1/inbound/brevo/email', payload: body as object, headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  x = await harness('bin19', 191);
  await withTenant(x.h.db, x.t, (tx) => createEndpoint(tx, x.keyring, { channel: 'email', lawfulBasis: 'steps at the request of the person', purpose: 'enquiries', inboundAddress: ADDRESS }, 'user:owner'));
  app = buildServer({
    intake: { ...x.intake, adapters: { ...x.intake.adapters, email: emailAdapter(signedWebhookAdapter('email'), TOKEN) } },
    publicBaseUrl: 'https://uk.sevari.example', limiter: new TokenBucketLimiter(x.clock, { capacity: 100, perMinute: 6000 }), ready: async () => true,
    owner: { db: x.h.db, keyring: x.keyring, clock: x.clock, consumers: x.deps.consumers }, brevoInbound: { token: TOKEN, domain: DOMAIN },
  });
});
afterAll(async () => { await app?.close(); await x?.close(); });

describe('[Inbound email] Brevo', () => {
  it('only Brevo can post: no token or the wrong token is refused before anything is read', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/inbound/brevo/email', payload: { items: [email()] } })).statusCode).toBe(401);
    expect((await post({ items: [email()] }, 'x'.repeat(TOKEN.length))).statusCode).toBe(401);
    // And the Brevo token can't be used to slip past a business's own signed-webhook endpoint either.
    const signed = (await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('channel_endpoints').select('public_id').where('channel', '=', 'email').where('inbound_address', 'is', null).executeTakeFirstOrThrow())).public_id;
    const r = await app.inject({ method: 'POST', url: `/v1/inbound/email/${signed}`, payload: email(), headers: { authorization: 'Bearer wrong-token-wrong-token-wrong-token-1' } });
    expect(r.statusCode).toBe(401);
  });

  it('routes each email to the business it was sent to; never answers out-of-office replies, bounces or spam; a repeat is stored once', async () => {
    const genuine = email();
    const batch = { items: [
      genuine,
      email({ Headers: { 'Auto-Submitted': 'auto-replied' }, Subject: 'Out of office' }),
      email({ From: { Address: 'MAILER-DAEMON@mail.example' }, Subject: 'Undeliverable' }),
      email({ Spam: { Score: 15 } }),
      email({ To: [{ Address: `nobody-000000@${DOMAIN}` }], Recipients: [{ Address: `nobody-000000@${DOMAIN}` }] }),
    ] };
    const r = await post(batch);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ accepted: 1, dropped: 3, unrouted: 1, rejected: 0 });
    expect((await post({ items: [genuine] })).json()).toMatchObject({ accepted: 1 });
    const msgs = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('messages').select(['id', 'channel', 'provider_message_id']).where('provider_message_id', '=', `brevo:${genuine.MessageId}`).execute());
    expect(msgs).toHaveLength(1);
  });

  it('the acknowledgement goes out with the business\'s receiving address as reply-to, so the customer\'s reply comes back', async () => {
    const e = email({ Subject: 'Toilet blocked', ExtractedMarkdownMessage: 'Can you unblock a toilet tomorrow? CH65 2AB' });
    await post({ items: [e] });
    const m = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('messages').select('id').where('provider_message_id', '=', `brevo:${e.MessageId}`).executeTakeFirstOrThrow());
    await x.process(m.id);
    await x.drain();
    const sent = [...x.provider.accepted.values()].filter((a) => a.env.to === 'sam@customer.example');
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((a) => a.env.replyTo === ADDRESS)).toBe(true);
  });

  it('the owner gets their own receiving address from the app', async () => {
    const token = await withTenant(x.h.db, x.t, (tx) => createUserToken(tx, x.clock, x.owner));
    const r = await app.inject({ method: 'POST', url: '/v1/owner/channels', payload: { channel: 'email' }, headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(201);
    expect((r.json() as { address: string }).address).toMatch(new RegExp(`^test-drainage-[0-9a-f]{6}@${DOMAIN.replace(/\./g, '\\.')}$`));
  });
});

describe('[Inbound email] what is never answered', () => {
  const parse = (o: Record<string, unknown>) => BrevoInboundItem.parse(email(o));
  it('recognises automatic mail by its headers and sender', () => {
    expect(dropReason(parse({}))).toBeNull();
    expect(dropReason(parse({ Headers: { 'auto-submitted': 'auto-generated' } }))).toBe('auto_reply');
    expect(dropReason(parse({ Headers: { 'Auto-Submitted': 'no' } }))).toBeNull();
    expect(dropReason(parse({ Headers: { Precedence: 'bulk' } }))).toBe('auto_reply');
    expect(dropReason(parse({ Headers: { 'List-Unsubscribe': '<mailto:x@y>' } }))).toBe('auto_reply');
    expect(dropReason(parse({ From: { Address: 'no-reply@shop.example' } }))).toBe('auto_reply');
    expect(dropReason(parse({ Spam: { Score: 12 } }))).toBe('spam');
  });
});
