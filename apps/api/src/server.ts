/**
 * Public HTTP surface for one cell. Phase 2: inbound channel endpoints and health.
 * Every inbound request is persisted encrypted and queued before the 202 is returned (§5.2).
 */
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { ChannelId } from '@sevari/channels';
import { findEndpoint } from '@sevari/db';
import { receiveInbound, type IntakeDeps } from '@sevari/intake';
import { registerAccountRoutes, type SignupTerms } from './accounts.ts';
import { registerOnboardingRoutes } from './onboarding.ts';
import { registerPortalRoutes } from './portal.ts';
import { registerOwnerRoutes, type OwnerDeps } from './owner.ts';
import type { CellLive } from '@sevari/onboarding';
import type { RateLimiter } from './rate-limit.ts';

export interface ServerDeps {
  readonly intake: IntakeDeps;
  /** The exact public origin the cell is served on, e.g. https://uk.sevari.example. Providers sign full URLs. */
  readonly publicBaseUrl: string;
  readonly limiter: RateLimiter;
  readonly ready: () => Promise<boolean>;
  readonly logger?: boolean;
  /** Owner app API (Phase 6/18). Omitted on intake-only nodes. */
  readonly owner?: OwnerDeps & { readonly cellLive?: CellLive };
  /** Sign-up and sign-in (§81, R-13). `region` is the cell's region; `signup` absent keeps sign-up closed. */
  readonly accounts?: { readonly region: string; readonly signup?: SignupTerms };
}

const CHANNELS: ReadonlySet<string> = new Set(['webform', 'email', 'sms', 'api']);
const MAX_BODY = 256 * 1024;

function securityHeaders(reply: FastifyReply): void {
  // The owner app sets its own (still strict, same-origin only) policy; everything else is locked down.
  if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
  reply.header('cache-control', 'no-store');
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: MAX_BODY, trustProxy: true, return503OnClosing: true });
  // Keep the exact bytes: signatures are computed over the raw body.
  for (const ct of ['application/json', 'application/x-www-form-urlencoded', 'text/plain']) {
    app.addContentTypeParser(ct, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  }
  app.addHook('onSend', async (_req, reply) => securityHeaders(reply));
  app.setErrorHandler((err, _req, reply) => {
    const code = (err as { statusCode?: unknown }).statusCode;
    const status = typeof code === 'number' && code >= 400 && code < 500 ? code : 500;
    // Never echo internals to the caller.
    reply.code(status).send({ error: status === 413 ? 'body too large' : status === 500 ? 'internal error' : 'bad request' });
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => (await deps.ready()) ? { status: 'ready' } : reply.code(503).send({ status: 'not ready' }));

  // CORS preflight for website forms: allowed only for the form's own configured origins.
  app.options<{ Params: { publicId: string } }>('/v1/inbound/webform/:publicId', async (req, reply) => {
    const origin = req.headers.origin;
    const ep = await findEndpoint(deps.intake.db, req.params.publicId);
    if (!origin || !ep || ep.channel !== 'webform' || !ep.allowedOrigins.includes(origin)) return reply.code(403).send();
    return reply.code(204).header('access-control-allow-origin', origin).header('vary', 'origin')
      .header('access-control-allow-methods', 'POST').header('access-control-allow-headers', 'content-type')
      .header('access-control-max-age', '600').send();
  });

  app.post<{ Params: { channel: string; publicId: string } }>('/v1/inbound/:channel/:publicId', async (req, reply) => {
    const { channel, publicId } = req.params;
    if (!CHANNELS.has(channel)) return reply.code(404).send({ error: 'unknown endpoint' });
    if (!deps.limiter.take(`${publicId}|${req.ip}`) || !deps.limiter.take(`endpoint|${publicId}`)) {
      return reply.code(429).header('retry-after', '60').send({ error: 'rate limited' });
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
    const result = await receiveInbound(deps.intake, {
      channel: channel as ChannelId, publicId,
      raw: { body, headers, url: deps.publicBaseUrl + req.url },
    });
    const origin = req.headers.origin;
    if (channel === 'webform' && origin && result.status !== 'rejected') reply.header('access-control-allow-origin', origin).header('vary', 'origin');
    switch (result.status) {
      case 'accepted':
        return reply.code(202).send({ status: 'accepted', ref: result.messageId, duplicate: result.duplicate });
      case 'dropped':
        // Indistinguishable from success, so bots learn nothing.
        return reply.code(202).send({ status: 'accepted' });
      case 'redirect':
        return reply.code(307).header('location', result.location + req.url).send();
      case 'rejected':
        return reply.code(result.httpStatus).send({ error: result.httpStatus === 404 ? 'unknown endpoint' : result.reason });
    }
  });

  if (deps.owner) {
    registerOwnerRoutes(app, deps.owner);
    registerOnboardingRoutes(app, deps.owner);
    registerPortalRoutes(app, deps.owner);
    if (deps.accounts) registerAccountRoutes(app, { db: deps.owner.db, keyring: deps.owner.keyring, clock: deps.owner.clock, publicBaseUrl: deps.publicBaseUrl, region: deps.accounts.region, limiter: deps.limiter, ...(deps.accounts.signup ? { signup: deps.accounts.signup } : {}) });
  }
  return app;
}
