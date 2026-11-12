/**
 * Onboarding routes for the business owner (§18, §81, §83). Owner credential only: team members and
 * Veylith operators can't set up or switch on someone else's business (§82, F58).
 *   POST /v1/owner/onboarding/answers    the interview → draft records, drafted pack (asked to confirm), regulated check
 *   POST /v1/owner/onboarding/confirm    the owner confirms the drafted records they have reviewed (I5)
 *   GET  /v1/owner/onboarding/checklist  the go-live checklist, each item in plain English
 *   POST /v1/owner/onboarding/channel-check  a one-time code to send in through a channel, proving it works
 *   POST /v1/owner/onboarding/go-live    asks for the go-live tap, or says exactly what is still missing
 *   POST /v1/owner/onboarding/import     contacts, only with a lawful basis and where they came from
 *   GET  /v1/owner/onboarding/records    the drafted records in plain English, to check before confirming (I5)
 *   GET  /v1/owner/channels              the business's channels and whether each has been tested
 *   POST /v1/owner/channels              a website enquiry form, with the code to paste into their site
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { appendAudit } from '@sevari/audit';
import { withTenant } from '@sevari/db';
import { ContractViolation } from '@sevari/domain';
import { authenticate, type Credential } from '@sevari/identity';
import { createEndpoint } from '@sevari/intake';
import { confirmRecord } from '@sevari/knowledge';
import { parseKnowledge } from '@sevari/domain';
import { askPackConfirm, describeKnowledge, goLiveChecklist, importContacts, requestGoLive, startChannelCheck, startOnboarding, type CellLive } from '@sevari/onboarding';
import type { OwnerDeps } from './owner.ts';

const NOT_CLEARED: CellLive = async () => ({ allowed: false, reasons: ['this cell has not been cleared for live businesses'] });
const ImportBody = z.object({
  rows: z.array(z.object({ name: z.string().max(120).optional(), email: z.string().max(254).optional(), phone: z.string().max(40).optional() })).max(5_000),
  lawful_basis: z.string().max(300),
  acquired_from: z.string().max(300),
}).strict();
const ChannelBody = z.object({ endpoint_public_id: z.string().min(8).max(80) }).strict();
const NewChannel = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('webform'), site: z.string().url().max(200) }).strict(),
  z.object({ channel: z.literal('email') }).strict(),
]);
/** Replying to an enquiry the person sent is a step they asked for before any contract (UK GDPR Art 6(1)(b)). */
const ENQUIRY_BASIS = 'steps at the request of the person before a contract: replying to the enquiry they sent';
const escapeAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const bearer = (req: FastifyRequest) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
const json = (req: FastifyRequest): unknown => {
  try { return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}'); } catch { return null; }
};

export function registerOnboardingRoutes(app: FastifyInstance, deps: OwnerDeps & { readonly cellLive?: CellLive; readonly publicBaseUrl?: string; readonly inboundEmailDomain?: string }): void {
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
      const ep = await tx.selectFrom('channel_endpoints').select(['id', 'channel']).where('public_id', '=', body.data.endpoint_public_id).executeTakeFirst();
      return ep ? { code: await startChannelCheck(tx, ep.id), channel: ep.channel } : null;
    });
    if (!code) return reply.code(404).send({ error: 'unknown channel' });
    const how = code.channel === 'webform' ? 'Fill in the new form on your website, the way a customer would, with' : code.channel === 'email' ? 'Email your Sevari address, the way a customer would, with' : 'Send a message to this channel, the way a customer would, with';
    return reply.send({ code: code.code, instructions: `${how} ${code.code} in the message. It shows as tested within a minute.` });
  });

  app.get('/v1/owner/onboarding/records', async (req, reply) => {
    const cred = await ownerOnly(req, reply);
    if (!cred) return reply;
    return withTenant(deps.db, cred.scope, async (tx) => {
      const rows = await tx.selectFrom('knowledge_records').select(['id', 'kind', 'body_enc']).where('status', '=', 'draft').orderBy('record_key').execute();
      const bodies = await Promise.all(rows.map(async (r) => ({ id: r.id, body: parseKnowledge(JSON.parse(await deps.keyring.openText(tx, { table: 'knowledge_records', column: 'body_enc', rowId: r.id }, r.body_enc))) })));
      const names = new Map(bodies.flatMap((b) => b.body.kind === 'service' ? [[b.body.code, b.body.name] as const] : []));
      const order = ['business', 'service', 'price', 'hours', 'area', 'policy', 'faq', 'resolution_policy'];
      return { records: bodies.map((b) => ({ id: b.id, kind: b.body.kind, ...describeKnowledge(b.body, names) })).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)) };
    });
  });

  app.get('/v1/owner/channels', async (req, reply) => {
    const cred = await ownerOnly(req, reply);
    if (!cred) return reply;
    const rows = await withTenant(deps.db, cred.scope, (tx) => tx.selectFrom('channel_endpoints').select(['public_id', 'channel', 'status', 'verified_at', 'allowed_origins', 'inbound_address']).orderBy('created_at').execute());
    return { channels: rows.map((r) => ({ id: r.public_id, channel: r.channel, active: r.status === 'active', tested: r.verified_at !== null, sites: r.allowed_origins, address: r.inbound_address })) };
  });

  app.post('/v1/owner/channels', async (req, reply) => {
    const cred = await ownerOnly(req, reply);
    if (!cred) return reply;
    const body = NewChannel.safeParse(json(req));
    if (!body.success) return reply.code(400).send({ error: 'Please give your website address, starting https://' });
    if (body.data.channel === 'email') {
      const domain = deps.inboundEmailDomain;
      if (!domain) return reply.code(503).send({ error: 'Receiving enquiries by email isn\'t switched on here yet.' });
      const r = await withTenant(deps.db, cred.scope, async (tx) => {
        const t = await tx.selectFrom('tenants').select('display_name').where('id', '=', cred.scope.tenantId).executeTakeFirstOrThrow();
        const slug = t.display_name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'enquiries';
        const address = `${slug}-${randomBytes(6).toString('hex').slice(0, 6)}@${domain.toLowerCase()}`;
        const ep = await createEndpoint(tx, deps.keyring, { channel: 'email', lawfulBasis: ENQUIRY_BASIS, purpose: 'enquiries', inboundAddress: address }, `user:${cred.userId}`);
        return { id: ep.publicId, address };
      });
      return reply.code(201).send({ ...r, instructions: `Customers can email ${r.address}. You can also forward your business email to it, or put it on your website.` });
    }
    const origin = new URL(body.data.site).origin;
    if (!origin.startsWith('https://')) return reply.code(400).send({ error: 'Your website needs to use https:// so enquiries are sent securely.' });
    const ep = await withTenant(deps.db, cred.scope, (tx) => createEndpoint(tx, deps.keyring, { channel: 'webform', lawfulBasis: ENQUIRY_BASIS, purpose: 'enquiries', allowedOrigins: [origin] }, `user:${cred.userId}`));
    const base = deps.publicBaseUrl ?? '';
    const snippet = `<form data-sevari-form="${escapeAttr(ep.publicId)}" data-sevari-endpoint="${escapeAttr(base)}/v1/inbound/webform/${escapeAttr(ep.publicId)}">\n  <label>Your name <input name="name" autocomplete="name"></label>\n  <label>Email <input name="email" type="email" autocomplete="email"></label>\n  <label>Phone <input name="phone" type="tel" autocomplete="tel"></label>\n  <label>How can we help? <textarea name="message" required></textarea></label>\n  <input name="company_website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">\n  <button type="submit">Send</button>\n  <p data-sevari-status role="status"></p>\n</form>\n<script src="${escapeAttr(base)}/embed/form.js" defer></script>`;
    return reply.code(201).send({ id: ep.publicId, site: origin, snippet });
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
