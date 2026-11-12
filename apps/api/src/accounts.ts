/**
 * Sign-up and sign-in (§81, R-13). Public routes, rate-limited per address and per IP, answering the same
 * way whether or not an email has an account. Sign-up stays closed until Veylith's customer terms and
 * privacy notice are published (a terms version and links in the cell's config): nobody can sign up to
 * terms that don't exist yet.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { exchangeSignIn, requestSignIn, requestSignup, signOut, verifySignup, type AccountDeps } from '@sevari/accounts';
import { authenticate } from '@sevari/identity';
import { withTenant } from '@sevari/db';
import type { RateLimiter } from './rate-limit.ts';

export interface SignupTerms {
  /** The version of Veylith's customer terms a person agrees to when signing up, e.g. "2026-12-01". */
  readonly termsVersion: string;
  readonly termsUrl: string;
  readonly privacyUrl: string;
}

export interface AccountRouteDeps extends AccountDeps {
  readonly limiter: RateLimiter;
  /** Absent: sign-up is closed (sign-in still works for existing accounts). */
  readonly signup?: SignupTerms;
}

const Signup = z.object({
  email: z.string().min(3).max(320),
  name: z.string().min(1).max(120),
  business: z.string().min(1).max(160),
  terms_version: z.string().min(1).max(40),
}).strict();
const Email = z.object({ email: z.string().min(3).max(320) }).strict();
const Token = z.object({ token: z.string().min(20).max(120) }).strict();

const json = (req: FastifyRequest): unknown => {
  try {
    return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}');
  } catch {
    return null;
  }
};
const bearer = (req: FastifyRequest) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
const CHECK_EMAIL = 'Check your email. If the address can be used, a link is on its way. It may take a minute.';

export function registerAccountRoutes(app: FastifyInstance, deps: AccountRouteDeps): void {
  const limited = (req: FastifyRequest, key: string) => !deps.limiter.take(`acct|${req.ip}`) || !deps.limiter.take(`acct|${key}`);

  app.get('/v1/signup/terms', async (_req, reply) => deps.signup
    ? reply.send({ open: true, terms_version: deps.signup.termsVersion, terms_url: deps.signup.termsUrl, privacy_url: deps.signup.privacyUrl })
    : reply.send({ open: false }));

  app.post('/v1/signup', async (req, reply) => {
    if (!deps.signup) return reply.code(503).send({ error: 'Sign-ups open soon.' });
    const body = Signup.safeParse(json(req));
    if (!body.success) return reply.code(400).send({ error: 'Please fill in your name, your business name and your email.' });
    if (body.data.terms_version !== deps.signup.termsVersion) return reply.code(409).send({ error: 'The terms have changed. Please reload the page and read them again.' });
    if (limited(req, body.data.email.trim().toLowerCase())) return reply.code(429).header('retry-after', '60').send({ error: 'Too many tries. Please wait a minute.' });
    try {
      await requestSignup(deps, { email: body.data.email, contactName: body.data.name, businessName: body.data.business, termsVersion: body.data.terms_version });
    } catch (err) {
      if (err instanceof RangeError) return reply.code(400).send({ error: 'Please check your email address.' });
      throw err;
    }
    return reply.code(202).send({ message: CHECK_EMAIL });
  });

  app.post('/v1/signup/verify', async (req, reply) => {
    const body = Token.safeParse(json(req));
    if (!body.success) return reply.code(400).send({ error: 'bad request' });
    if (limited(req, 'verify')) return reply.code(429).header('retry-after', '60').send({ error: 'Too many tries. Please wait a minute.' });
    const r = await verifySignup(deps, body.data.token);
    if (r.status !== 'ok') return reply.code(410).send({ error: r.status === 'expired' ? 'This link has expired. Please sign up again.' : 'This link has already been used or isn\'t valid. Try signing in instead.' });
    return reply.send({ session: r.session });
  });

  app.post('/v1/signin', async (req, reply) => {
    const body = Email.safeParse(json(req));
    if (!body.success) return reply.code(400).send({ error: 'Please enter your email address.' });
    if (limited(req, body.data.email.trim().toLowerCase())) return reply.code(429).header('retry-after', '60').send({ error: 'Too many tries. Please wait a minute.' });
    await requestSignIn(deps, body.data.email);
    return reply.code(202).send({ message: CHECK_EMAIL });
  });

  app.post('/v1/signin/verify', async (req, reply) => {
    const body = Token.safeParse(json(req));
    if (!body.success) return reply.code(400).send({ error: 'bad request' });
    if (limited(req, 'verify')) return reply.code(429).header('retry-after', '60').send({ error: 'Too many tries. Please wait a minute.' });
    const r = await exchangeSignIn(deps, body.data.token);
    return r ? reply.send({ session: r.session }) : reply.code(410).send({ error: 'This sign-in link has expired or been used. Please ask for a new one.' });
  });

  app.post('/v1/owner/signout', async (req, reply) => {
    const presented = bearer(req);
    const cred = await authenticate(deps.db, deps.clock, presented);
    if (!cred || cred.kind !== 'user' || !presented) return reply.code(204).send();
    await withTenant(deps.db, cred.scope, (tx) => signOut(tx, cred.userId, presented));
    return reply.code(204).send();
  });

  /** Who is signed in, for the app's header: business name, status and the person's role. */
  app.get('/v1/owner/me', async (req, reply) => {
    const cred = await authenticate(deps.db, deps.clock, bearer(req));
    if (!cred) return reply.code(401).send({ error: 'sign in required' });
    if (cred.kind !== 'user') return reply.code(403).send({ error: 'operator credentials cannot act for a business' });
    return withTenant(deps.db, cred.scope, async (tx) => {
      const t = await tx.selectFrom('tenants').select(['display_name', 'status']).where('id', '=', cred.scope.tenantId).executeTakeFirstOrThrow();
      const u = await tx.selectFrom('users').select('display_name_enc').where('id', '=', cred.userId).executeTakeFirstOrThrow();
      return { business: t.display_name, status: t.status, role: cred.role, name: await deps.keyring.openText(tx, { table: 'users', column: 'display_name_enc', rowId: cred.userId }, u.display_name_enc) };
    });
  });
}
