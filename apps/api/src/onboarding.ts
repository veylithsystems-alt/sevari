/**
 * Onboarding routes for the business owner (§18, §81, §83). Owner credential only: team members and
 * Veylith operators can't set up or switch on someone else's business (§82, F58).
 *   POST /v1/owner/onboarding/answers    the interview → draft records, drafted pack (asked to confirm), regulated check
 *   POST /v1/owner/onboarding/confirm    the owner confirms the drafted records they have reviewed (I5)
 *   GET  /v1/owner/onboarding/checklist  the go-live checklist, each item in plain English
 *   POST /v1/owner/onboarding/channel-check  a one-time code to send in through a channel, proving it works
 *   POST /v1/owner/onboarding/go-live    asks for the go-live tap, or says exactly what is still missing
 *   POST /v1/owner/onboarding/import     contacts, only with a lawful basis and where they came from
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { appendAudit } from '@sevari/audit';
import { withTenant } from '@sevari/db';
import { ContractViolation } from '@sevari/domain';
import { authenticate, type Credential } from '@sevari/identity';
import { confirmRecord } from '@sevari/knowledge';
import { askPackConfirm, goLiveChecklist, importContacts, requestGoLive, startChannelCheck, startOnboarding, type CellLive } from '@sevari/onboarding';
import type { OwnerDeps } from './owner.ts';

const NOT_CLEARED: CellLive = async () => ({ allowed: false, reasons: ['this cell has not been cleared for live businesses'] });
const ImportBody = z.object({
  rows: z.array(z.object({ name: z.string().max(120).optional(), email: z.string().max(254).optional(), phone: z.string().max(40).optional() })).max(5_000),
  lawful_basis: z.string().max(300),
  acquired_from: z.string().max(300),
}).strict();
const ChannelBody = z.object({ endpoint_public_id: z.string().min(8).max(80) }).strict();

const bearer = (req: FastifyRequest) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
const json = (req: FastifyRequest): unknown => {
  try { return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}'); } catch { return null; }
};

export function registerOnboardingRoutes(app: FastifyInstance, deps: OwnerDeps & { readonly cellLive?: CellLive }): void {
  const cellLive = deps.cellLive ?? NOT_CLEARED;
  const ownerOnly = async (req: FastifyRequest, reply: FastifyReply): Promise<Extract<Credential, { kind: 'user' }> | null> => {
    const cred = await authenticate(deps.db, deps.clock, bearer(req));
    if (!cred) { await reply.code(401).send({ error: 'sign in required' }); return null; }
    if (cred.kind !== 'user') { await reply.code(403).send({ error: 'operator credentials cannot act for a business' }); return null; }
    if (cred.role !== 'owner') { await reply.code(403).send({ error: 'only the owner can set up the business' }); return null; }
    return cred;
  };
  const hitl = { keyring: deps.keyring, clock: deps.clock, consumers: deps.consumers };

  app.post('/v1/owner/onboarding/answers', async (req, reply) => {
    const cred = await ownerOnly(req, reply);
    if (!cred) return reply;
    try {
      const r = await withTenant(deps.db, cred.scope, async (tx) => {
        const o = await startOnboarding(deps, tx, json(req), `user:${cred.userId}`);
        if (o.packId) await askPackConfirm(hitl, tx, o.packId);
        return o;
      });
      return reply.code(201).send({
        records_to_confirm: r.recordIds.length, pack_drafted: r.packId !== null,
        practice_enquiries: { total: r.report.total, passed: r.report.passed, problems: r.report.failures },
        regulated: r.regulated.map((f) => ({ activity: f.activity, why: f.why })),
      });
    } catch (err) {
      if (err instanceof z.ZodError) return reply.code(400).send({ error: 'some answers are missing or not valid', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
      throw err;
    }
  });

  app.post('/v1/owner/onboarding/confirm', async (req, reply) => {
    const cred = await ownerOnly(req, reply);
    if (!cred) return reply;
    const n = await withTenant(deps.db, cred.scope, async (tx) => {
      const drafts = await tx.selectFrom('knowledge_records').select('id').where('status', '=', 'draft').where('source', '=', 'onboarding_interview').execute();
      for (const d of drafts) await confirmRecord(tx, deps.clock, { id: d.id, confirmedBy: `user:${cred.userId}` });
      await appendAudit(tx, { type: 'onboarding.records_confirmed', actor: { kind: 'user', ref: cred.userId }, subject: `tenant:${cred.scope.tenantId}`, payload: { records: drafts.length } });
      return drafts.length;
    });
    return reply.send({ confirmed: n });
  });

  app.get('/v1/owner/onboarding/checklist', async (req, reply) => {
    const cred = await ownerOnly(req, reply);
    if (!cred) return reply;
    return withTenant(deps.db, cred.scope, (tx) => goLiveChecklist({ keyring: deps.keyring, clock: deps.clock, cellLive }, tx));
  });

  app.post('/v1/owner/onboarding/channel-check', async (req, reply) => {
    const cred = await ownerOnly(req, reply);
    if (!cred) return reply;
    const body = ChannelBody.safeParse(json(req));
    if (!body.success) return reply.code(400).send({ error: 'bad request' });
    const code = await withTenant(deps.db, cred.scope, async (tx) => {
      const ep = await tx.selectFrom('channel_endpoints').select('id').where('public_id', '=', body.data.endpoint_public_id).executeTakeFirst();
      return ep ? startChannelCheck(tx, ep.id) : null;
    });
    if (!code) return reply.code(404).send({ error: 'unknown channel' });
    return reply.send({ code, instructions: `Send a message containing ${code} to this channel, the way a customer would. It will show as connected within a minute.` });
  });

  app.post('/v1/owner/onboarding/go-live', async (req, reply) => {
    const cred = await ownerOnly(req, reply);
    if (!cred) return reply;
    const r = await withTenant(deps.db, cred.scope, (tx) => requestGoLive({ ...hitl, cellLive }, tx));
    return reply.code(r.status === 'blocked' ? 409 : 200).send(r);
  });

  app.post('/v1/owner/onboarding/import', async (req, reply) => {
    const cred = await ownerOnly(req, reply);
    if (!cred) return reply;
    const body = ImportBody.safeParse(json(req));
    if (!body.success) return reply.code(400).send({ error: 'bad request' });
    try {
      const r = await withTenant(deps.db, cred.scope, (tx) => importContacts(deps, tx, { rows: body.data.rows, lawfulBasis: body.data.lawful_basis, acquiredFrom: body.data.acquired_from, importedBy: `user:${cred.userId}` }));
      return reply.code(201).send(r);
    } catch (err) {
      if (err instanceof ContractViolation) return reply.code(422).send({ error: err.message });
      throw err;
    }
  });
}
