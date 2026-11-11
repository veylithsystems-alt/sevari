/**
 * The customer's own page (§22): GET /p/:token shows their booking and invoices with payment links, and two
 * one-click controls: stop marketing, or stop all messages. No scripts, no third-party anything, plain
 * accessible HTML (WCAG 2.2 AA target). Owner routes: their business's data export, and a request to leave.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withTenant } from '@sevari/db';
import { authenticate, type Credential } from '@sevari/identity';
import { snapshotAt } from '@sevari/knowledge';
import { exportTenantBundle, openPortal, portalStopAll, portalStopMarketing, portalView, cancelOffboarding, requestOffboarding, type PortalView } from '@sevari/privacy';
import type { OwnerDeps } from './owner.ts';

const PORTAL_CSP = "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const money = (minor: number, cur: string) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format(minor / 100);
const when = (iso: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }).format(new Date(iso));

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head><body><main>${body}</main></body></html>`;
}

export function renderPortal(token: string, v: PortalView, notice?: string): string {
  const t = encodeURIComponent(token);
  const bookings = v.bookings.length ? `<ul>${v.bookings.map((b) => `<li>${esc(when(b.startsAt))} (${esc(b.status)})</li>`).join('')}</ul>` : '<p>No bookings.</p>';
  const invoices = v.invoices.length
    ? `<ul>${v.invoices.map((i) => `<li>Invoice ${esc(i.number)}: ${esc(money(i.total, i.currency))}, ${esc(i.status === 'paid' ? 'paid' : 'to pay')}${i.payUrl && i.status !== 'paid' ? ` <a href="${esc(i.payUrl)}">Pay securely</a>` : ''}</li>`).join('')}</ul>` : '<p>No invoices.</p>';
  return page(`Your details with ${v.business}`, `
<h1>Your details with ${esc(v.business)}</h1>
${notice ? `<p role="status"><strong>${esc(notice)}</strong></p>` : ''}
<h2>Bookings</h2>${bookings}
<h2>Invoices</h2>${invoices}
<h2>Your choices</h2>
${v.stopped ? '<p>You have asked us not to contact you. We won\'t send you any more messages.</p>' : `
<form method="post" action="/p/${t}/stop-marketing"><button type="submit">Stop marketing messages</button></form>
<form method="post" action="/p/${t}/stop-all"><button type="submit">Stop all messages from ${esc(v.business)}</button></form>`}
<p>To change a booking, just reply to our last message.</p>
${v.privacyUrl ? `<p><a href="${esc(v.privacyUrl)}">How we use your information</a></p>` : ''}`);
}

export function registerPortalRoutes(app: FastifyInstance, deps: OwnerDeps): void {
  const session = async (req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    const s = await openPortal(deps.db, deps.clock, req.params.token);
    if (!s) {
      await reply.code(404).header('content-security-policy', PORTAL_CSP).type('text/html; charset=utf-8').send(page('Link not valid', '<h1>This link has expired or isn\'t valid</h1><p>Please reply to our last message and we\'ll send you a new one.</p>'));
      return null;
    }
    return s;
  };
  const show = async (reply: FastifyReply, token: string, s: NonNullable<Awaited<ReturnType<typeof openPortal>>>, notice?: string) => {
    const b = await withTenant(deps.db, s.scope, async (tx) => (await snapshotAt(tx, deps.keyring, deps.clock.nowMs())).business?.body);
    const v = await portalView(deps, s, { name: b?.trading_name ?? 'this business', privacyUrl: b?.privacy_notice_url ?? null });
    return reply.header('content-security-policy', PORTAL_CSP).header('cache-control', 'no-store').type('text/html; charset=utf-8').send(renderPortal(token, v, notice));
  };
  app.get<{ Params: { token: string } }>('/p/:token', async (req, reply) => {
    const s = await session(req, reply);
    return s ? show(reply, req.params.token, s) : reply;
  });
  app.post<{ Params: { token: string } }>('/p/:token/stop-marketing', async (req, reply) => {
    const s = await session(req, reply);
    if (!s) return reply;
    await portalStopMarketing(deps, s);
    return show(reply, req.params.token, s, 'Done. You won\'t get any more marketing messages.');
  });
  app.post<{ Params: { token: string } }>('/p/:token/stop-all', async (req, reply) => {
    const s = await session(req, reply);
    if (!s) return reply;
    await portalStopAll(deps, s);
    return show(reply, req.params.token, s, 'Done. You won\'t get any more messages from us.');
  });

  const ownerOnly = async (req: FastifyRequest, reply: FastifyReply): Promise<Extract<Credential, { kind: 'user' }> | null> => {
    const cred = await authenticate(deps.db, deps.clock, /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]);
    if (!cred || cred.kind !== 'user' || cred.role !== 'owner') { await reply.code(cred ? 403 : 401).send({ error: 'the business owner only' }); return null; }
    return cred;
  };
  app.get('/v1/owner/export', async (req, reply) => {
    const cred = await ownerOnly(req, reply);
    if (!cred) return reply;
    const bundle = await withTenant(deps.db, cred.scope, (tx) => exportTenantBundle(deps, tx));
    return reply.header('content-disposition', 'attachment; filename="sevari-export.json"').header('cache-control', 'no-store').send(bundle);
  });
  app.post('/v1/owner/offboarding', async (req, reply) => {
    const cred = await ownerOnly(req, reply);
    if (!cred) return reply;
    const r = await withTenant(deps.db, cred.scope, (tx) => requestOffboarding(deps, tx, 'owner'));
    return reply.code(201).send({ notice_until: r.noticeUntil.toISOString(), grace_until: r.graceUntil.toISOString(), message: 'Your data export is available now and until the end of the grace period. Nothing is deleted before then, and the final deletion is confirmed by Veylith.' });
  });
  app.post('/v1/owner/offboarding/cancel', async (req, reply) => {
    const cred = await ownerOnly(req, reply);
    if (!cred) return reply;
    const ok = await withTenant(deps.db, cred.scope, (tx) => cancelOffboarding(tx));
    return ok ? reply.send({ message: 'Cancelled. You are staying with Sevari: nothing will be deleted and there is no final bill.' }) : reply.code(409).send({ error: 'nothing_to_cancel' });
  });
}
