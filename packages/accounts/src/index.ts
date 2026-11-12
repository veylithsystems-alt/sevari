/**
 * Accounts (§81, R-13): self-serve sign-up and email sign-in, with no setup call and no passwords.
 *
 *   requestSignup()   someone types their name, business and email. Nothing is created yet: the details
 *                     are kept encrypted for 24 hours and a confirmation link is emailed.
 *   verifySignup()    the link is used once: the business is created (not live; onboarding starts), its
 *                     owner gets a login, and Veylith's owner is told. Safe to retry after a crash.
 *   requestSignIn()   a single-use sign-in link (15 minutes) to each business the address belongs to.
 *                     The answer is the same whether or not the address has an account.
 *   exchangeSignIn()  the link becomes a session; signOut() revokes it.
 *
 * All of this is Veylith's own record about its customers, so it lives in the house tenant (Veylith's
 * account) with the same walls, encryption and audit as everything else. Emails are a fixed set of kinds
 * written here, never customer messages: those only ever go through the outbox and its contact rules.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { enqueue, findHouseTenant, sql, withTenant, type Db, type TenantTx } from '@sevari/db';
import { normaliseEmail, regionCode, tenantId, type TenantScope } from '@sevari/domain';
import { notify, ownerOf } from '@sevari/hitl';
import { createUserToken } from '@sevari/identity';
import type { OutboundProvider } from '@sevari/outbound';

export const SIGNUP_TTL_MS = 24 * 3_600_000;
export const SIGNIN_TTL_MS = 15 * 60_000;
/** At most this many sign-up or sign-in emails to one address an hour, whoever asks. */
export const MAILS_PER_ADDRESS_PER_HOUR = 3;
export const ACCOUNT_MAIL_JOB = 'account_mail.send';
const MAX_MAIL_ATTEMPTS = 5;

export interface AccountDeps {
  readonly db: Db;
  readonly keyring: TenantKeyring;
  readonly clock: Clock;
  /** The cell's public origin; links in emails point here. */
  readonly publicBaseUrl: string;
  /** The cell's region (one cell, one region). */
  readonly region: string;
}

export type AccountMailInput = { readonly kind: 'signup_verify' | 'signin_link' | 'already_registered' | 'brief_ready'; readonly to: string; readonly subject: string; readonly text: string };

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
function newToken(kind: 'sr' | 'll'): { prefix: string; full: string } {
  const prefix = `${kind}_` + Array.from(randomBytes(12), (b) => ALPHA[b % ALPHA.length]).join('');
  return { prefix, full: `${prefix}.${randomBytes(32).toString('base64url')}` };
}
const TOKEN = /^((?:sr|ll)_[a-z0-9]{12})\.([A-Za-z0-9_-]{40,60})$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;
const field = (table: string, column: string, rowId: string) => ({ table, column, rowId });

async function house(deps: Pick<AccountDeps, 'db' | 'region'>): Promise<TenantScope> {
  const h = await findHouseTenant(deps.db, deps.region);
  if (!h) throw new Error(`no house tenant (Veylith's account) in region ${deps.region}`);
  return h;
}

/** Queues one account email in the house tenant; the worker hands it to the provider. */
export async function queueAccountMail(deps: Pick<AccountDeps, 'keyring' | 'clock'>, tx: TenantTx, m: AccountMailInput): Promise<string> {
  const id = randomUUID();
  await tx.insertInto('account_mail').values({
    id, tenant_id: tx.scope.tenantId, region: tx.scope.region, kind: m.kind, subject: m.subject,
    recipient_enc: await deps.keyring.seal(tx, field('account_mail', 'recipient_enc', id), normaliseEmail(m.to)),
    body_enc: await deps.keyring.seal(tx, field('account_mail', 'body_enc', id), m.text),
  }).execute();
  await enqueue(tx, { kind: ACCOUNT_MAIL_JOB, dedupeKey: `mail:${id}`, runAt: deps.clock.now(), payload: { mail_id: id } });
  return id;
}

/** Queues an account email to a business's own user, from Veylith's account (e.g. "your brief is ready"). */
export async function mailUser(deps: Pick<AccountDeps, 'db' | 'keyring' | 'clock' | 'region'>, business: TenantScope, userId: string, m: Omit<AccountMailInput, 'to'>): Promise<string | null> {
  const to = await withTenant(deps.db, business, async (tx) => {
    const u = await tx.selectFrom('users').select(['email_enc', 'status']).where('id', '=', userId).executeTakeFirst();
    return u?.email_enc && u.status === 'active' ? deps.keyring.openText(tx, field('users', 'email_enc', userId), u.email_enc) : null;
  });
  if (!to) return null;
  return withTenant(deps.db, await house(deps), (tx) => queueAccountMail(deps, tx, { ...m, to }));
}

async function recentMails(tx: TenantTx, deps: Pick<AccountDeps, 'clock'>, bidx: Buffer): Promise<number> {
  const since = new Date(deps.clock.nowMs() - 3_600_000);
  const s = await tx.selectFrom('signup_requests').select(sql<string>`count(*)`.as('n')).where('email_bidx', '=', bidx).where('expires_at', '>', new Date(since.getTime() + SIGNUP_TTL_MS)).executeTakeFirstOrThrow();
  const l = await tx.selectFrom('login_links').innerJoin('account_directory', (j) => j.onRef('account_directory.member_user_id', '=', 'login_links.member_user_id'))
    .select(sql<string>`count(DISTINCT login_links.id)`.as('n')).where('account_directory.email_bidx', '=', bidx).where('login_links.issued_at', '>', since).executeTakeFirstOrThrow();
  return Number(s.n) + Number(l.n);
}

/** Creates single-use sign-in links for each business this address belongs to, in one email. */
async function signInMail(deps: AccountDeps, tx: TenantTx, to: string, members: readonly { member_tenant_id: string; member_user_id: string }[], kind: 'signin_link' | 'already_registered'): Promise<void> {
  const lines: string[] = [];
  for (const m of members) {
    const t = newToken('ll');
    await tx.insertInto('login_links').values({
      tenant_id: tx.scope.tenantId, region: tx.scope.region, prefix: t.prefix, token_hash: sha256(t.full),
      member_tenant_id: m.member_tenant_id, member_user_id: m.member_user_id, issued_at: deps.clock.now(), expires_at: new Date(deps.clock.nowMs() + SIGNIN_TTL_MS),
    }).execute();
    const name = await withTenant(deps.db, { tenantId: tenantId(m.member_tenant_id), region: regionCode(tx.scope.region) }, (mt) => mt.selectFrom('tenants').select('display_name').where('id', '=', m.member_tenant_id).executeTakeFirst());
    lines.push(`${name?.display_name ?? 'Your business'}: ${deps.publicBaseUrl}/app#signin=${t.full}`);
  }
  const intro = kind === 'already_registered'
    ? 'Someone (hopefully you) tried to sign up to Sevari with this email address, but it already has an account. To sign in instead, use this link:'
    : 'Here is your link to sign in to Sevari:';
  await queueAccountMail(deps, tx, {
    kind, to, subject: 'Your Sevari sign-in link',
    text: `${intro}\n\n${lines.join('\n')}\n\nThe link works once, for 15 minutes. If you didn't ask for it, you can ignore this email: nobody can sign in without it.\n\nSevari, by Veylith`,
  });
}

export type SignupInput = { readonly email: string; readonly contactName: string; readonly businessName: string; readonly termsVersion: string };

/**
 * Starts a sign-up. Always answers the same way, so the form never reveals whether an address has an
 * account. Only a confirmation link is emailed; nothing is created until it is used.
 */
export async function requestSignup(deps: AccountDeps, input: SignupInput): Promise<void> {
  const email = normaliseEmail(input.email);
  if (!EMAIL.test(email)) throw new RangeError('invalid email');
  const name = input.contactName.trim().slice(0, 120);
  const business = input.businessName.trim().slice(0, 160);
  if (!name || !business) throw new RangeError('name and business are required');
  const h = await house(deps);
  await withTenant(deps.db, h, async (tx) => {
    const bidx = await deps.keyring.index(tx, 'email', email);
    if (await recentMails(tx, deps, bidx) >= MAILS_PER_ADDRESS_PER_HOUR) {
      await appendAudit(tx, { type: 'signup.throttled', actor: { kind: 'system' }, subject: 'signup', payload: {} });
      return;
    }
    const members = await tx.selectFrom('account_directory').select(['member_tenant_id', 'member_user_id']).where('email_bidx', '=', bidx).execute();
    if (members.length) {
      await signInMail(deps, tx, email, members, 'already_registered');
      return;
    }
    const id = randomUUID();
    const t = newToken('sr');
    await tx.insertInto('signup_requests').values({
      id, tenant_id: h.tenantId, region: h.region, prefix: t.prefix, token_hash: sha256(t.full), email_bidx: bidx,
      email_enc: await deps.keyring.seal(tx, field('signup_requests', 'email_enc', id), email),
      contact_name_enc: await deps.keyring.seal(tx, field('signup_requests', 'contact_name_enc', id), name),
      business_name_enc: await deps.keyring.seal(tx, field('signup_requests', 'business_name_enc', id), business),
      expires_at: new Date(deps.clock.nowMs() + SIGNUP_TTL_MS),
    }).execute();
    await queueAccountMail(deps, tx, {
      kind: 'signup_verify', to: email, subject: 'Confirm your email to start with Sevari',
      text: `Hello ${name},\n\nThanks for signing ${business} up to Sevari. Please confirm this is your email address:\n\n${deps.publicBaseUrl}/app#signup=${t.full}\n\nThe link works once, within 24 hours. Then you can set up your business in about ten minutes. If you didn't sign up, ignore this email and these details are deleted within a day.\n\nSevari, by Veylith`,
    });
    // Which terms they agreed to is evidence (§59): kept with the request's audit record.
    await appendAudit(tx, { type: 'signup.requested', actor: { kind: 'system' }, subject: `signup:${id}`, payload: { terms_version: input.termsVersion } });
  });
}

export type VerifyResult =
  | { readonly status: 'ok'; readonly session: string; readonly tenantId: string }
  | { readonly status: 'invalid' | 'expired' };

/** Confirms a sign-up: creates the business (not live) and its owner's login. Single use; safe to retry. */
export async function verifySignup(deps: AccountDeps, token: string): Promise<VerifyResult> {
  const m = TOKEN.exec(token);
  if (!m?.[1]?.startsWith('sr_')) return { status: 'invalid' };
  const prefix = m[1];
  const h = await house(deps);
  // 1. Claim the request (row lock: two clicks can't both create a business).
  const claim = await withTenant(deps.db, h, async (tx) => {
    const r = await tx.selectFrom('signup_requests').selectAll().where('prefix', '=', prefix).forUpdate().executeTakeFirst();
    if (!r || !timingSafeEqual(r.token_hash, sha256(token))) return { status: 'invalid' as const };
    if (r.status === 'completed' || r.status === 'expired') return { status: 'invalid' as const };
    if (r.status === 'pending' && r.expires_at.getTime() <= deps.clock.nowMs()) {
      await tx.updateTable('signup_requests').set({ status: 'expired', email_enc: null, contact_name_enc: null, business_name_enc: null }).where('id', '=', r.id).execute();
      return { status: 'expired' as const };
    }
    if (!r.email_enc || !r.contact_name_enc || !r.business_name_enc) return { status: 'invalid' as const };
    const newId = r.new_tenant_id ?? randomUUID();
    if (r.status === 'pending') await tx.updateTable('signup_requests').set({ status: 'verifying', new_tenant_id: newId }).where('id', '=', r.id).execute();
    return {
      status: 'claimed' as const, id: r.id, newId,
      email: await deps.keyring.openText(tx, field('signup_requests', 'email_enc', r.id), r.email_enc),
      name: await deps.keyring.openText(tx, field('signup_requests', 'contact_name_enc', r.id), r.contact_name_enc),
      business: await deps.keyring.openText(tx, field('signup_requests', 'business_name_enc', r.id), r.business_name_enc),
    };
  });
  if (claim.status !== 'claimed') return claim;

  // 2. The business and its owner, in the business's own scope. A retry finds them already there.
  const scope: TenantScope = { tenantId: tenantId(claim.newId), region: h.region };
  const { userId, session } = await withTenant(deps.db, scope, async (tx) => {
    const exists = await tx.selectFrom('tenants').select('id').where('id', '=', claim.newId).executeTakeFirst();
    let owner: string;
    if (exists) {
      owner = (await tx.selectFrom('users').select('id').where('role', '=', 'owner').executeTakeFirstOrThrow()).id;
    } else {
      await tx.insertInto('tenants').values({ id: claim.newId, region: h.region, display_name: claim.business }).execute();
      await deps.keyring.provision(tx);
      owner = randomUUID();
      await tx.insertInto('users').values({
        id: owner, tenant_id: claim.newId, region: h.region, role: 'owner',
        display_name_enc: await deps.keyring.seal(tx, field('users', 'display_name_enc', owner), claim.name),
        email_enc: await deps.keyring.seal(tx, field('users', 'email_enc', owner), claim.email),
        email_bidx: await deps.keyring.index(tx, 'email', claim.email),
      }).execute();
      await appendAudit(tx, { type: 'tenant.signed_up', actor: { kind: 'user', ref: owner }, subject: `tenant:${claim.newId}`, payload: { via: 'self_serve' } });
    }
    return { userId: owner, session: await createUserToken(tx, deps.clock, owner) };
  });

  // 3. Veylith's records: the sign-in directory, the request closed and its details destroyed, Dan told.
  await withTenant(deps.db, h, async (tx) => {
    await tx.insertInto('account_directory').values({ tenant_id: h.tenantId, region: h.region, email_bidx: await deps.keyring.index(tx, 'email', claim.email), member_tenant_id: claim.newId, member_user_id: userId })
      .onConflict((oc) => oc.columns(['tenant_id', 'email_bidx', 'member_tenant_id', 'member_user_id']).doNothing()).execute();
    await tx.updateTable('signup_requests').set({ status: 'completed', email_enc: null, contact_name_enc: null, business_name_enc: null }).where('id', '=', claim.id).execute();
    const dan = await ownerOf(tx);
    if (dan) await notify(tx, deps.keyring, { userId: dan, kind: 'info', ref: `tenant:${claim.newId}`, dedupeKey: `signup:${claim.id}`, text: `New sign-up: ${claim.business}. They're setting up now; nothing goes to their customers until they go live.` });
    await appendAudit(tx, { type: 'signup.completed', actor: { kind: 'system' }, subject: `signup:${claim.id}`, payload: { tenant: claim.newId } });
  });
  return { status: 'ok', session, tenantId: claim.newId };
}

/** Emails single-use sign-in links. Answers the same way whether or not the address has an account. */
export async function requestSignIn(deps: AccountDeps, rawEmail: string): Promise<void> {
  const email = normaliseEmail(rawEmail);
  if (!EMAIL.test(email)) return;
  const h = await house(deps);
  await withTenant(deps.db, h, async (tx) => {
    const bidx = await deps.keyring.index(tx, 'email', email);
    const members = await tx.selectFrom('account_directory').select(['member_tenant_id', 'member_user_id']).where('email_bidx', '=', bidx).execute();
    if (!members.length) return;
    if (await recentMails(tx, deps, bidx) >= MAILS_PER_ADDRESS_PER_HOUR * members.length) return;
    await signInMail(deps, tx, email, members, 'signin_link');
  });
}

/** Turns a sign-in link into a session, once, within 15 minutes, for an active user only. */
export async function exchangeSignIn(deps: AccountDeps, token: string): Promise<{ readonly session: string } | null> {
  const m = TOKEN.exec(token);
  if (!m?.[1]?.startsWith('ll_')) return null;
  const prefix = m[1];
  const h = await house(deps);
  const link = await withTenant(deps.db, h, async (tx) => {
    const l = await tx.selectFrom('login_links').selectAll().where('prefix', '=', prefix).forUpdate().executeTakeFirst();
    if (!l || l.used_at || l.expires_at.getTime() <= deps.clock.nowMs() || !timingSafeEqual(l.token_hash, sha256(token))) return null;
    await tx.updateTable('login_links').set({ used_at: deps.clock.now() }).where('id', '=', l.id).execute();
    return l;
  });
  if (!link) return null;
  const scope: TenantScope = { tenantId: tenantId(link.member_tenant_id), region: h.region };
  return withTenant(deps.db, scope, async (tx) => {
    const t = await tx.selectFrom('tenants').select('status').where('id', '=', link.member_tenant_id).executeTakeFirst();
    const u = await tx.selectFrom('users').select('status').where('id', '=', link.member_user_id).executeTakeFirst();
    if (!t || t.status === 'closed' || u?.status !== 'active') return null;
    await appendAudit(tx, { type: 'user.signed_in', actor: { kind: 'user', ref: link.member_user_id }, subject: `user:${link.member_user_id}`, payload: { via: 'email_link' } });
    return { session: await createUserToken(tx, deps.clock, link.member_user_id) };
  });
}

/** A business that has been erased can no longer be signed in to: its directory entries and links go. */
export async function forgetBusinessAccounts(deps: Pick<AccountDeps, 'db' | 'region'>, businessTenantId: string): Promise<number> {
  const h = await findHouseTenant(deps.db, deps.region);
  if (!h) return 0;
  return withTenant(deps.db, h, async (tx) => {
    await tx.deleteFrom('login_links').where('member_tenant_id', '=', businessTenantId).execute();
    const r = await tx.deleteFrom('account_directory').where('member_tenant_id', '=', businessTenantId).executeTakeFirst();
    return Number(r.numDeletedRows);
  });
}

/**
 * Hands one account email to the provider. A provider "try later" retries; a failure after five tries
 * tells Veylith's owner. Once handed over (or given up), the address and the link are destroyed.
 * A duplicate sign-in email is harmless, so an unclear result is retried (unlike customer messages).
 */
export async function sendAccountMail(deps: { db: Db; keyring: TenantKeyring; clock: Clock; provider: OutboundProvider }, scope: TenantScope, mailId: string): Promise<'sent' | 'failed' | 'already'> {
  const mail = await withTenant(deps.db, scope, async (tx) => {
    const r = await tx.selectFrom('account_mail').selectAll().where('id', '=', mailId).executeTakeFirst();
    if (!r || r.state !== 'pending' || !r.recipient_enc || !r.body_enc) return null;
    return {
      subject: r.subject, attempts: r.attempts,
      to: await deps.keyring.openText(tx, field('account_mail', 'recipient_enc', r.id), r.recipient_enc),
      text: await deps.keyring.openText(tx, field('account_mail', 'body_enc', r.id), r.body_enc),
    };
  });
  if (!mail) return 'already';
  const settle = (state: 'sent' | 'failed', extra: { provider_message_id?: string; last_error?: string }) => withTenant(deps.db, scope, async (tx) => {
    await tx.updateTable('account_mail').set({ state, recipient_enc: null, body_enc: null, ...(state === 'sent' ? { sent_at: deps.clock.now() } : {}), ...extra }).where('id', '=', mailId).where('state', '=', 'pending').execute();
    await appendAudit(tx, { type: `account_mail.${state}`, actor: { kind: 'system' }, subject: `account_mail:${mailId}`, payload: extra.last_error ? { error: extra.last_error.slice(0, 200) } : {} });
    if (state === 'failed') {
      const dan = await ownerOf(tx);
      if (dan) await notify(tx, deps.keyring, { userId: dan, kind: 'warning', ref: `account_mail:${mailId}`, dedupeKey: `mailfail:${mailId}`, text: `An account email ("${mail.subject}") could not be delivered. The person may need to try again or contact support.` });
    }
  });
  const retryOrFail = async (why: string): Promise<'failed'> => {
    if (mail.attempts + 1 >= MAX_MAIL_ATTEMPTS) {
      await settle('failed', { last_error: why });
      return 'failed';
    }
    await withTenant(deps.db, scope, (tx) => tx.updateTable('account_mail').set({ attempts: mail.attempts + 1, last_error: why.slice(0, 200) }).where('id', '=', mailId).execute());
    throw new Error(`account email not sent yet: ${why}`);
  };
  let outcome;
  try {
    outcome = await deps.provider.send({ reference: mailId, channel: 'email', to: mail.to, subject: mail.subject, text: mail.text });
  } catch (err) {
    return retryOrFail(err instanceof Error ? err.message : 'provider error');
  }
  if (outcome.status === 'accepted') {
    await settle('sent', { provider_message_id: outcome.providerMessageId });
    return 'sent';
  }
  if (outcome.status === 'deferred') return retryOrFail(outcome.reason);
  await settle('failed', { last_error: outcome.reason });
  return 'failed';
}

/** Ends a session: the token stops working at once. */
export async function signOut(tx: TenantTx, userId: string, presented: string): Promise<void> {
  const prefix = presented.split('.')[0] ?? '';
  await tx.updateTable('user_tokens').set({ status: 'revoked' }).where('prefix', '=', prefix).where('user_id', '=', userId).execute();
  await appendAudit(tx, { type: 'user.signed_out', actor: { kind: 'user', ref: userId }, subject: `user:${userId}`, payload: {} });
}
