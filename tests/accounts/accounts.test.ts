import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, TokenBucketLimiter } from '@sevari/api';
import {
  exchangeSignIn, forgetBusinessAccounts, MAILS_PER_ADDRESS_PER_HOUR, requestSignIn, requestSignup, sendAccountMail, signOut, verifySignup, type AccountDeps,
} from '@sevari/accounts';
import { withTenant, type TenantTx } from '@sevari/db';
import { authenticate } from '@sevari/identity';
import { FakeProvider } from '@sevari/outbound';
import { superQuery } from '../support/fixtures.ts';
import { harness, type Harness } from '../support/hitl-harness.ts';

/** Self-serve sign-up and email sign-in (§81, R-13), all held in Veylith's own account. */
let house: Harness;
let deps: AccountDeps;
const mail = new FakeProvider();
const hdb = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(house.h.db, house.t, fn);
const BASE = 'https://uk.sevari.example';

/** Sends every queued account email through the fake provider; returns the texts sent to `to`. */
async function inbox(to: string): Promise<string[]> {
  const pending = await hdb((tx) => tx.selectFrom('account_mail').select('id').where('state', '=', 'pending').execute());
  for (const m of pending) await sendAccountMail({ db: house.h.db, keyring: house.keyring, clock: house.clock, provider: mail }, house.t, m.id);
  return [...mail.accepted.values()].filter((a) => a.env.to === to).map((a) => a.env.text);
}
const linkIn = (text: string | undefined, kind: 'signup' | 'signin') => {
  const m = new RegExp(`#${kind}=((?:sr|ll)_[a-z0-9]{12}\\.[A-Za-z0-9_-]+)`).exec(text ?? '');
  if (!m?.[1]) throw new Error(`no ${kind} link in: ${text}`);
  return m[1];
};

beforeAll(async () => {
  house = await harness('acc16', 161);
  await superQuery('UPDATE tenants SET is_house = true WHERE id = $1', [house.t.tenantId]);
  deps = { db: house.h.db, keyring: house.keyring, clock: house.clock, publicBaseUrl: BASE, region: 'acc16' };
});
afterAll(async () => house?.close());

describe('[Accounts] sign-up', () => {
  it('nothing is created until the email is confirmed; the link works once and creates a business that is not live', async () => {
    await requestSignup(deps, { email: 'Sam@Plumbing.example', contactName: 'Sam Example', businessName: 'Sam\'s Plumbing (example)', termsVersion: 't1' });
    const before = await hdb((tx) => tx.selectFrom('signup_requests').select(['status', 'email_enc']).execute());
    expect(before).toHaveLength(1);
    expect(before[0]!.email_enc).not.toBeNull();
    const [text] = await inbox('sam@plumbing.example');
    expect(text).toMatch(/Confirm|confirm this is your email/);
    const token = linkIn(text, 'signup');
    // The sent email's address and link are destroyed once handed to the provider.
    expect(await hdb((tx) => tx.selectFrom('account_mail').select(['recipient_enc', 'body_enc', 'state']).execute())).toEqual([{ recipient_enc: null, body_enc: null, state: 'sent' }]);

    const r = await verifySignup(deps, token);
    if (r.status !== 'ok') throw new Error(r.status);
    const cred = await authenticate(house.h.db, house.clock, r.session);
    expect(cred).toMatchObject({ kind: 'user', role: 'owner' });
    if (cred?.kind !== 'user') throw new Error('not a user');
    const t = await withTenant(house.h.db, cred.scope, (tx) => tx.selectFrom('tenants').select(['display_name', 'status']).executeTakeFirstOrThrow());
    expect(t).toEqual({ display_name: 'Sam\'s Plumbing (example)', status: 'onboarding' });
    // The typed details are gone from the request; Dan is told.
    expect(await hdb((tx) => tx.selectFrom('signup_requests').select(['status', 'email_enc', 'contact_name_enc', 'business_name_enc']).executeTakeFirstOrThrow()))
      .toEqual({ status: 'completed', email_enc: null, contact_name_enc: null, business_name_enc: null });
    const told = await hdb((tx) => tx.selectFrom('human_notifications').select('ref').where('ref', '=', `tenant:${r.tenantId}`).execute());
    expect(told).toHaveLength(1);
    // Used once only.
    expect(await verifySignup(deps, token)).toEqual({ status: 'invalid' });
    expect(await verifySignup(deps, token.slice(0, -2) + 'xx')).toEqual({ status: 'invalid' });
  });

  it('signing up again with the same address sends a sign-in link instead, and creates nothing', async () => {
    const before = (await hdb((tx) => tx.selectFrom('signup_requests').select('id').execute())).length;
    await requestSignup(deps, { email: 'sam@plumbing.example', contactName: 'Someone', businessName: 'Another', termsVersion: 't1' });
    expect((await hdb((tx) => tx.selectFrom('signup_requests').select('id').execute())).length).toBe(before);
    const texts = await inbox('sam@plumbing.example');
    expect(texts.at(-1)).toMatch(/already has an account/);
    expect(await exchangeSignIn(deps, linkIn(texts.at(-1), 'signin'))).toMatchObject({ session: expect.stringMatching(/^ut_/) });
  });

  it('an unconfirmed sign-up expires after 24 hours and its details are destroyed', async () => {
    await requestSignup(deps, { email: 'late@example.com', contactName: 'Late', businessName: 'Late Ltd (example)', termsVersion: 't1' });
    const token = linkIn((await inbox('late@example.com'))[0], 'signup');
    house.clock.advance(25 * 3_600_000);
    expect(await verifySignup(deps, token)).toEqual({ status: 'expired' });
    const r = await hdb((tx) => tx.selectFrom('signup_requests').select(['status', 'email_enc']).where('status', '=', 'expired').executeTakeFirstOrThrow());
    expect(r.email_enc).toBeNull();
  });

  it('one address gets at most a few emails an hour, whoever asks', async () => {
    for (let i = 0; i < MAILS_PER_ADDRESS_PER_HOUR + 2; i++) await requestSignup(deps, { email: 'spam-target@example.com', contactName: 'X', businessName: 'X', termsVersion: 't1' });
    expect(await inbox('spam-target@example.com')).toHaveLength(MAILS_PER_ADDRESS_PER_HOUR);
  });

  it('the database keeps these records in Veylith\'s own account only', async () => {
    const biz = await harness('acc16', 162);
    try {
      await expect(withTenant(biz.h.db, biz.t, (tx) => tx.insertInto('signup_requests').values({
        tenant_id: biz.t.tenantId, region: biz.t.region, prefix: 'sr_aaaaaaaaaaaa', token_hash: Buffer.alloc(32), email_bidx: Buffer.alloc(32), expires_at: new Date(biz.clock.nowMs() + 1000),
      }).execute())).rejects.toThrow(/house tenant/);
    } finally {
      await biz.close();
    }
  });
});

describe('[Accounts] sign-in', () => {
  it('a sign-in link works once, for 15 minutes; signing out ends the session at once', async () => {
    await requestSignIn(deps, 'SAM@plumbing.example ');
    const link = linkIn((await inbox('sam@plumbing.example')).at(-1), 'signin');
    const s = await exchangeSignIn(deps, link);
    if (!s) throw new Error('no session');
    expect(await exchangeSignIn(deps, link)).toBeNull();
    const cred = await authenticate(house.h.db, house.clock, s.session);
    if (cred?.kind !== 'user') throw new Error('not signed in');
    await withTenant(house.h.db, cred.scope, (tx) => signOut(tx, cred.userId, s.session));
    expect(await authenticate(house.h.db, house.clock, s.session)).toBeNull();

    house.clock.advance(3_600_000);
    await requestSignIn(deps, 'sam@plumbing.example');
    const late = linkIn((await inbox('sam@plumbing.example')).at(-1), 'signin');
    house.clock.advance(16 * 60_000);
    expect(await exchangeSignIn(deps, late)).toBeNull();
  });

  it('an unknown address gets nothing, and the answer looks the same', async () => {
    const before = (await hdb((tx) => tx.selectFrom('account_mail').select('id').execute())).length;
    await expect(requestSignIn(deps, 'nobody@example.com')).resolves.toBeUndefined();
    expect((await hdb((tx) => tx.selectFrom('account_mail').select('id').execute())).length).toBe(before);
  });

  it('once a business is erased, nobody can sign in to it', async () => {
    house.clock.advance(3_600_000);
    await requestSignup(deps, { email: 'leaving@example.com', contactName: 'L', businessName: 'Leaving Ltd (example)', termsVersion: 't1' });
    const r = await verifySignup(deps, linkIn((await inbox('leaving@example.com'))[0], 'signup'));
    if (r.status !== 'ok') throw new Error(r.status);
    expect(await forgetBusinessAccounts(deps, r.tenantId)).toBe(1);
    const before = (await inbox('leaving@example.com')).length;
    await requestSignIn(deps, 'leaving@example.com');
    expect(await inbox('leaving@example.com')).toHaveLength(before);
  });
});

describe('[Accounts] the web routes', () => {
  it('sign-up is closed until the terms are published, then works end to end through the API', async () => {
    const base = { intake: { db: house.h.db, keyring: house.keyring, clock: house.clock, cellRegion: house.t.region, cellUrls: {}, adapters: {} } as never, publicBaseUrl: BASE, limiter: new TokenBucketLimiter(house.clock, { capacity: 100, perMinute: 100 }), ready: async () => true, owner: { db: house.h.db, keyring: house.keyring, clock: house.clock, consumers: house.deps.consumers } };
    const closed = buildServer({ ...base, accounts: { region: 'acc16' } });
    const open = buildServer({ ...base, accounts: { region: 'acc16', signup: { termsVersion: '2026-12-01', termsUrl: `${BASE}/terms`, privacyUrl: `${BASE}/privacy` } } });
    try {
      const body = { email: 'web@example.com', name: 'Web Person', business: 'Web Trades (example)', terms_version: '2026-12-01' };
      expect((await closed.inject({ method: 'POST', url: '/v1/signup', payload: body })).statusCode).toBe(503);
      expect((await open.inject({ method: 'POST', url: '/v1/signup', payload: { ...body, terms_version: 'old' } })).statusCode).toBe(409);
      expect((await open.inject({ method: 'POST', url: '/v1/signup', payload: body })).statusCode).toBe(202);
      const token = linkIn((await inbox('web@example.com'))[0], 'signup');
      const v = await open.inject({ method: 'POST', url: '/v1/signup/verify', payload: { token } });
      expect(v.statusCode).toBe(200);
      const session = (v.json() as { session: string }).session;
      const me = await open.inject({ method: 'GET', url: '/v1/owner/me', headers: { authorization: `Bearer ${session}` } });
      expect(me.json()).toEqual({ business: 'Web Trades (example)', status: 'onboarding', role: 'owner', name: 'Web Person' });
      expect((await open.inject({ method: 'POST', url: '/v1/owner/signout', headers: { authorization: `Bearer ${session}` } })).statusCode).toBe(204);
      expect((await open.inject({ method: 'GET', url: '/v1/owner/me', headers: { authorization: `Bearer ${session}` } })).statusCode).toBe(401);
      expect((await open.inject({ method: 'POST', url: '/v1/signin', payload: { email: 'nobody@example.com' } })).json()).toEqual((await open.inject({ method: 'POST', url: '/v1/signin', payload: { email: 'web@example.com' } })).json());
    } finally {
      await closed.close();
      await open.close();
    }
  });
});
