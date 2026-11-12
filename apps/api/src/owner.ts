/**
 * Owner app API (§7.1, §30, §74, §82). Every route needs a credential:
 *   /v1/owner/*      a tenant user credential. Operator credentials are refused (F58).
 *   /v1/platform/*   an operator credential. Tenant credentials are refused and audited (F56).
 * Answers are acknowledged in the response itself (the in-app channel, §74.1) and in the inbox.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { withTenant, type Db } from '@sevari/db';
import { answer, type ConsumerRegistry } from '@sevari/hitl';
import { authenticate, platformDecision, type Credential } from '@sevari/identity';
import { downloadCopy } from '@sevari/privacy';
import { signOut } from '@sevari/accounts';
import { latestBrief } from '@sevari/metrics';

export interface OwnerDeps {
  readonly db: Db;
  readonly keyring: TenantKeyring;
  readonly clock: Clock;
  readonly consumers: ConsumerRegistry;
}

const AnswerBody = z.object({
  response: z.string().min(1).max(40),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  detail: z.string().max(4_000).optional(),
}).strict();
const DecisionBody = z.object({ decision: z.string().min(3).max(80), subject_ref: z.string().min(3).max(200), reason: z.string().min(3).max(500) }).strict();

const bearer = (req: FastifyRequest) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
const json = (req: FastifyRequest): unknown => {
  try {
    return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}');
  } catch {
    return null;
  }
};

const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');
/** The owner app's static files (Phase 6 inbox). Same-origin only: no third-party scripts, fonts or trackers. */
const APP_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  '/app': { file: 'app.html', type: 'text/html; charset=utf-8' },
  '/app/': { file: 'app.html', type: 'text/html; charset=utf-8' },
  '/app/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/app/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json' },
  '/app/icon.svg': { file: 'icon.svg', type: 'image/svg+xml' },
};
const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; manifest-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export function registerOwnerRoutes(app: FastifyInstance, deps: OwnerDeps): void {
  for (const [path, f] of Object.entries(APP_FILES)) {
    app.get(path, async (_req, reply) => reply.header('content-security-policy', APP_CSP).type(f.type).send(await readFile(join(PUBLIC_DIR, f.file))));
  }

  const userOnly = async (req: FastifyRequest, reply: FastifyReply): Promise<Extract<Credential, { kind: 'user' }> | null> => {
    const cred = await authenticate(deps.db, deps.clock, bearer(req));
    if (!cred) {
      await reply.code(401).send({ error: 'sign in required' });
      return null;
    }
    if (cred.kind !== 'user') {
      // F58: Veylith never approves or acts on a tenant's behalf.
      await reply.code(403).send({ error: 'operator credentials cannot act for a business' });
      return null;
    }
    return cred;
  };
  const open = (tx: Parameters<Parameters<typeof withTenant>[2]>[0], table: string, column: string, rowId: string, enc: Buffer) => deps.keyring.openText(tx, { table, column, rowId }, enc);

  app.get('/v1/owner/inbox', async (req, reply) => {
    const cred = await userOnly(req, reply);
    if (!cred) return reply;
    return withTenant(deps.db, cred.scope, async (tx) => {
      const qs = await tx.selectFrom('human_questions').selectAll().where('status', '=', 'open')
        .$if(cred.role !== 'owner', (q) => q.where('assigned_user_id', '=', cred.userId)).orderBy('presented_at').limit(100).execute();
      const ns = await tx.selectFrom('human_notifications').select(['id', 'kind', 'ref', 'body_enc', 'status', 'created_at'])
        .where('user_id', '=', cred.userId).orderBy('created_at', 'desc').limit(100).execute();
      return {
        role: cred.role,
        questions: await Promise.all(qs.map(async (q) => ({
          id: q.id, kind: q.kind, digest: q.content_digest.toString('hex'), options: q.options, deadline: q.deadline_at.toISOString(),
          safe_default: q.safe_default, assigned_to_me: q.assigned_user_id === cred.userId,
          body: JSON.parse(await open(tx, 'human_questions', 'body_enc', q.id, q.body_enc)) as unknown,
        }))),
        notifications: await Promise.all(ns.map(async (n) => ({ id: n.id, kind: n.kind, ref: n.ref, status: n.status, at: n.created_at.toISOString(), text: await open(tx, 'human_notifications', 'body_enc', n.id, n.body_enc) }))),
      };
    });
  });

  app.post<{ Params: { id: string } }>('/v1/owner/questions/:id/answer', async (req, reply) => {
    const cred = await userOnly(req, reply);
    if (!cred) return reply;
    const body = AnswerBody.safeParse(json(req));
    if (!body.success || !/^[0-9a-f-]{36}$/.test(req.params.id)) return reply.code(400).send({ error: 'bad request' });
    const r = await withTenant(deps.db, cred.scope, (tx) => answer({ keyring: deps.keyring, clock: deps.clock, consumers: deps.consumers }, tx, {
      questionId: req.params.id, responderId: cred.userId, response: body.data.response, digestSeen: body.data.digest, channel: 'app',
      ...(body.data.detail ? { detail: body.data.detail } : {}),
    }));
    return reply.code(r.accepted ? 200 : 409).send(r.accepted ? { accepted: true, ack: r.ack, ...(r.outcome ? { outcome: r.outcome } : {}) } : { accepted: false, reason: r.reason, ack: r.ack });
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

  /** The latest morning brief or evening summary (§78), for the top of the inbox. */
  app.get('/v1/owner/brief', async (req, reply) => {
    const cred = await userOnly(req, reply);
    if (!cred) return reply;
    const b = await withTenant(deps.db, cred.scope, (tx) => latestBrief(deps, tx));
    return b ? { kind: b.kind, period_end: b.periodEnd, waiting: b.waiting, lines: b.lines.map((l) => ({ section: l.section, text: l.text })) } : { kind: null };
  });

  app.post<{ Params: { id: string } }>('/v1/owner/notifications/:id/read', async (req, reply) => {
    const cred = await userOnly(req, reply);
    if (!cred) return reply;
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return reply.code(400).send({ error: 'bad request' });
    await withTenant(deps.db, cred.scope, (tx) => tx.updateTable('human_notifications').set({ status: 'read', read_at: new Date(deps.clock.nowMs()) })
      .where('id', '=', req.params.id).where('user_id', '=', cred.userId).execute());
    return reply.code(204).send();
  });

  // A person's copy of their data (§21.2): one download, before expiry, through the link they were sent.
  app.get<{ Params: { token: string } }>('/v1/dsar/:token', async (req, reply) => {
    const r = await downloadCopy(deps.db, deps, req.params.token, withTenant);
    if (r.status !== 'ok') {
      return r.status === 'gone' ? reply.code(410).send({ error: 'This link has been used or has expired. Please ask the business for a new one.' }) : reply.code(404).send({ error: 'not found' });
    }
    return reply.type('application/json; charset=utf-8').header('content-disposition', 'attachment; filename="your-information.json"').send(r.body);
  });

  app.post('/v1/platform/decisions', async (req, reply) => {
    const cred = await authenticate(deps.db, deps.clock, bearer(req));
    if (!cred) return reply.code(401).send({ error: 'sign in required' });
    const body = DecisionBody.safeParse(json(req));
    if (!body.success) return reply.code(400).send({ error: 'bad request' });
    try {
      const id = await platformDecision(deps.db, cred, { decision: body.data.decision, subjectRef: body.data.subject_ref, reason: body.data.reason });
      return reply.code(201).send({ id });
    } catch {
      return reply.code(403).send({ error: 'platform decisions need a platform operator credential' });
    }
  });
}
