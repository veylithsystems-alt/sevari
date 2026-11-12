/**
 * The customer portal (§22): one magic link per person, showing their own booking and invoices, with
 * one-click privacy controls (stop marketing; stop everything). Only that person's own records, read
 * in their business's scope. Links expire and can be destroyed; they are stored only as hashes.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { findPortalToken, withTenant, type Db, type TenantTx } from '@sevari/db';
import type { TenantScope } from '@sevari/domain';
import { suppress } from '@sevari/outbound';

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';

export async function issuePortalLink(deps: { clock: Clock }, tx: TenantTx, contactId: string, days = 30): Promise<string> {
  const prefix = `pl_${Array.from(randomBytes(12), (b) => ALPHA[b % ALPHA.length]).join('')}`;
  const token = `${prefix}.${randomBytes(32).toString('base64url')}`;
  await tx.insertInto('portal_tokens').values({ tenant_id: tx.scope.tenantId, region: tx.scope.region, contact_id: contactId, prefix, token_hash: sha256(token), expires_at: new Date(deps.clock.nowMs() + days * 86_400_000) }).execute();
  return token;
}

export interface PortalSession { readonly scope: TenantScope; readonly contactId: string; readonly tokenId: string }

export async function openPortal(db: Db, clock: Clock, token: string): Promise<PortalSession | null> {
  const m = /^(pl_[a-z0-9]{12})\.[A-Za-z0-9_-]{30,100}$/.exec(token);
  const route = m?.[1] ? await findPortalToken(db, m[1]) : null;
  if (!route || route.expiresAt.getTime() <= clock.nowMs()) return null;
  const h = sha256(token);
  if (h.length !== route.tokenHash.length || !timingSafeEqual(h, route.tokenHash)) return null;
  return { scope: { tenantId: route.tenantId, region: route.region }, contactId: route.contactId, tokenId: route.id };
}

export interface PortalView {
  readonly business: string;
  readonly privacyUrl: string | null;
  readonly bookings: readonly { readonly startsAt: string; readonly endsAt: string; readonly status: string }[];
  readonly invoices: readonly { readonly number: string; readonly total: number; readonly currency: string; readonly status: string; readonly payUrl: string | null }[];
  readonly marketing: boolean;
  readonly stopped: boolean;
}

export async function portalView(deps: { db: Db; keyring: TenantKeyring; clock: Clock }, s: PortalSession, business: { name: string; privacyUrl: string | null }): Promise<PortalView> {
  return withTenant(deps.db, s.scope, async (tx) => {
    await tx.updateTable('portal_tokens').set({ last_used_at: deps.clock.now() }).where('id', '=', s.tokenId).execute();
    const bookings = await tx.selectFrom('bookings').select(['starts_at', 'ends_at', 'status']).where('contact_id', '=', s.contactId).where('status', 'in', ['confirmed', 'completed']).orderBy('starts_at', 'desc').limit(10).execute();
    const invoices = await tx.selectFrom('invoices').select(['id', 'number', 'total_minor', 'currency', 'status']).where('contact_id', '=', s.contactId).where('status', 'in', ['issued', 'part_paid', 'paid']).execute();
    const links = invoices.length ? await tx.selectFrom('payment_links').select(['invoice_id', 'url']).where('invoice_id', 'in', invoices.map((i) => i.id)).where('status', '=', 'open').execute() : [];
    const consent = await tx.selectFrom('consents').select('action').where('contact_id', '=', s.contactId).where('purpose', '=', 'marketing').orderBy('recorded_at', 'desc').limit(1).executeTakeFirst();
    const c = await tx.selectFrom('contacts').select(['email_bidx', 'phone_bidx']).where('id', '=', s.contactId).executeTakeFirst();
    const idx = [c?.email_bidx, c?.phone_bidx].filter((x): x is Buffer => Buffer.isBuffer(x));
    const stopped = idx.length > 0 && (await tx.selectFrom('suppressions').select('id').where('recipient_bidx', 'in', idx).where('channel_scope', '=', 'all').execute()).length > 0;
    return {
      business: business.name, privacyUrl: business.privacyUrl,
      bookings: bookings.map((b) => ({ startsAt: b.starts_at.toISOString(), endsAt: b.ends_at.toISOString(), status: b.status })),
      invoices: invoices.map((i) => ({ number: i.number ?? '', total: Number(i.total_minor), currency: i.currency, status: i.status, payUrl: links.find((l) => l.invoice_id === i.id)?.url ?? null })),
      marketing: consent?.action === 'granted', stopped,
    };
  });
}

/** One click: no more marketing, on any channel. Recorded in the consent ledger like any withdrawal. */
export async function portalStopMarketing(deps: { db: Db; clock: Clock }, s: PortalSession): Promise<void> {
  await withTenant(deps.db, s.scope, async (tx) => {
    await tx.insertInto('consents').values({ tenant_id: s.scope.tenantId, region: s.scope.region, contact_id: s.contactId, purpose: 'marketing', channel: 'all', action: 'withdrawn', basis: 'consent', source: 'portal', recorded_at: deps.clock.now() }).execute();
    await appendAudit(tx, { type: 'consent.withdrawn', actor: { kind: 'customer', ref: `contact:${s.contactId}` }, subject: `contact:${s.contactId}`, payload: { purpose: 'marketing', via: 'portal' } });
  });
}

/** One click: no more messages of any kind from this business, from now (§17.2: opt-outs take effect immediately). */
export async function portalStopAll(deps: { db: Db; keyring: TenantKeyring; clock: Clock }, s: PortalSession): Promise<void> {
  await withTenant(deps.db, s.scope, async (tx) => {
    const c = await tx.selectFrom('contacts').select(['id', 'email_enc', 'phone_enc']).where('id', '=', s.contactId).executeTakeFirstOrThrow();
    if (c.email_enc) await suppress(tx, deps.keyring, { channel: 'all', recipient: await deps.keyring.openText(tx, { table: 'contacts', column: 'email_enc', rowId: c.id }, c.email_enc), recipientKind: 'email', reason: 'opt_out_request', sourceRef: `portal:${s.tokenId}` });
    if (c.phone_enc) await suppress(tx, deps.keyring, { channel: 'all', recipient: await deps.keyring.openText(tx, { table: 'contacts', column: 'phone_enc', rowId: c.id }, c.phone_enc), recipientKind: 'sms', reason: 'opt_out_request', sourceRef: `portal:${s.tokenId}` });
    await tx.insertInto('consents').values({ tenant_id: s.scope.tenantId, region: s.scope.region, contact_id: s.contactId, purpose: 'marketing', channel: 'all', action: 'withdrawn', basis: 'consent', source: 'portal', recorded_at: deps.clock.now() }).execute();
  });
}
