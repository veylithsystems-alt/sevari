import { describe, expect, it } from 'vitest';
import { EgressClient, EgressDenied, type EgressPolicy } from '@sevari/egress';
import { BrevoProvider, BREVO_HOST, type HttpPort } from '@sevari/outbound';

const KEY = 'xkeysib-test-not-a-real-key-000000';
const sender = { email: 'replies@mail.veylith.example', name: 'Port Drains (example)' };
const env = { reference: '6a1f7a8e-1111-4222-8333-444455556666', channel: 'email' as const, to: 'casey@example.com', text: 'Hello,\n\nThanks for your message.' };

const port = (status: number, body: unknown, seen: Parameters<HttpPort>[0][] = []): HttpPort => async (req) => {
  seen.push(req);
  return { status, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) };
};

describe('[Providers] Brevo transactional email (ADR email-brevo)', () => {
  it('sends exactly what the outbox holds, with our reference attached, and records Brevo\'s message id', async () => {
    const seen: Parameters<HttpPort>[0][] = [];
    const p = new BrevoProvider(port(201, { messageId: '<202610211200.123@smtp-relay.mailin.fr>' }, seen), { apiKey: KEY, sender, replyTo: 'office@portdrains.example' });
    expect(await p.send(env)).toEqual({ status: 'accepted', providerMessageId: '<202610211200.123@smtp-relay.mailin.fr>' });
    const req = seen[0]!;
    expect(req.url).toBe(`https://${BREVO_HOST}/v3/smtp/email`);
    expect(req.headers['api-key']).toBe(KEY);
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body).toMatchObject({ sender, to: [{ email: 'casey@example.com' }], replyTo: { email: 'office@portdrains.example' }, textContent: env.text, headers: { 'X-Sevari-Ref': env.reference }, tags: [`sevari:${env.reference}`] });
  });

  it('never claims what it can\'t know: no idempotency, no lookup, so a lost answer is ambiguous (a person checks)', async () => {
    const p = new BrevoProvider(async () => { throw new Error('socket hang up'); }, { apiKey: KEY, sender });
    expect(p.supportsIdempotencyKey).toBe(false);
    expect(p.supportsLookup).toBe(false);
    await expect(p.send(env)).rejects.toThrow(/socket hang up/);
    expect(await p.lookup()).toBeNull();
    await expect(new BrevoProvider(port(500, 'oops'), { apiKey: KEY, sender }).send(env)).rejects.toThrow(/server error/);
    await expect(new BrevoProvider(port(201, {}), { apiKey: KEY, sender }).send(env)).rejects.toThrow(/without a message id/);
  });

  it('a rate or daily limit means "not sent, try later"; a blocked address is suppressed; bad credentials are never a send', async () => {
    expect(await new BrevoProvider(port(429, { code: 'too_many_requests', message: 'daily limit' }), { apiKey: KEY, sender }).send(env)).toMatchObject({ status: 'deferred' });
    expect(await new BrevoProvider(port(400, { code: 'invalid_parameter', message: 'Contact is blacklisted' }), { apiKey: KEY, sender }).send(env)).toMatchObject({ status: 'rejected', suppress: true });
    expect(await new BrevoProvider(port(400, { code: 'invalid_parameter', message: 'email is not valid' }), { apiKey: KEY, sender }).send(env)).toMatchObject({ status: 'rejected', suppress: false });
    await expect(new BrevoProvider(port(401, { code: 'unauthorized' }), { apiKey: KEY, sender }).send(env)).rejects.toThrow(/credentials/);
    expect(await new BrevoProvider(port(201, { messageId: 'x' }), { apiKey: KEY, sender }).send({ ...env, channel: 'sms' })).toMatchObject({ status: 'rejected' });
    expect(() => new BrevoProvider(port(201, {}), { apiKey: '', sender })).toThrow(/secrets store/);
  });

  it('cannot reach Brevo unless the cell allowlist (an approved processor) allows it', async () => {
    const closed: EgressPolicy = { version: 1, default: 'deny', cells: { uk: { hosts: [] } } };
    const transport = async () => ({ status: 201, headers: {}, body: Buffer.from('{"messageId":"m1"}') });
    const denied = new EgressClient({ policy: closed, region: 'uk', transport });
    await expect(new BrevoProvider((r) => denied.send(r), { apiKey: KEY, sender }).send(env)).rejects.toBeInstanceOf(EgressDenied);
    const open: EgressPolicy = { version: 1, default: 'deny', cells: { uk: { hosts: [{ host: BREVO_HOST, port: 443, processor: 'brevo', purpose: 'transactional email', private_network: false }] } } };
    const allowed = new EgressClient({ policy: open, region: 'uk', transport });
    expect(await new BrevoProvider((r) => allowed.send(r), { apiKey: KEY, sender }).send(env)).toEqual({ status: 'accepted', providerMessageId: 'm1' });
  });
});
