/**
 * Data-rights requests (§21.2). Detected on every channel by the deterministic core, clocked (one month),
 * assembled automatically, and released only by a human (§8.3). For tenant data the tenant is the
 * controller, so the business owner decides; Sevari does the work.
 *
 * The copy of a person's data is built from the erasure registry (only fields declared `dsar: true`,
 * F20), sealed with the person's own key, and handed over through a one-time, expiring link.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { sql, type Db, type DsarKind, type TenantTx } from '@sevari/db';
import { normaliseForMatch, hasAffirmed, regionCode, tenantId, type TenantScope } from '@sevari/domain';
import { ERASURE_REGISTRY } from './registry.ts';

const KIND_RULES: ReadonlyArray<[Exclude<DsarKind, 'unspecified'>, readonly string[]]> = [
  ['erasure', ['delete my data', 'erase my data', 'delete my details', 'remove my details', 'remove my data', 'right to be forgotten', 'forget me', 'delete everything', 'delete all my information']],
  ['portability', ['data portability', 'machine readable', 'transfer my data']],
  ['access', ['subject access', 'access request', 'what data you hold', 'what information you hold', 'copy of my data', 'copy of my information', 'what do you hold', 'what you have on me']],
  ['rectification', ['correct my details', 'update my details', 'wrong details', 'rectify', 'my details are wrong']],
  ['objection', ['object to', 'stop processing', 'stop using my data']],
  ['restriction', ['restrict processing', 'restriction of processing']],
];

/** Which right the person is asking about. Unclear stays 'unspecified' and the owner decides (never a guess). */
export function classifyRightsRequest(text: string): DsarKind {
  const h = normaliseForMatch(text);
  return KIND_RULES.find(([, phrases]) => phrases.some((p) => hasAffirmed(h, p)))?.[0] ?? 'unspecified';
}

/** One calendar month from receipt (UK GDPR Art. 12(3)); a short month clamps to its last day. Counsel confirms extensions. */
export function dueDate(receivedAt: Date): Date {
  const d = new Date(receivedAt.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export interface OpenDsar {
  readonly contactId: string;
  readonly sourceMessageId: string;
  readonly kind: DsarKind;
  /** Email and SMS arrive on the person's own address or number; a form or API call could name anyone. */
  readonly identity: 'channel_verified' | 'unverified';
  readonly receivedAt: Date;
}

export async function openDsar(tx: TenantTx, d: OpenDsar): Promise<{ id: string; dueAt: Date; created: boolean }> {
  const existing = await tx.selectFrom('dsar_requests').select(['id', 'due_at']).where('source_message_id', '=', d.sourceMessageId).executeTakeFirst();
  if (existing) return { id: existing.id, dueAt: existing.due_at, created: false };
  const dueAt = dueDate(d.receivedAt);
  const r = await tx.insertInto('dsar_requests').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, contact_id: d.contactId, source_message_id: d.sourceMessageId, kind: d.kind,
    identity: d.identity, received_at: d.receivedAt, due_at: dueAt,
  }).returning('id').executeTakeFirstOrThrow();
  await appendAudit(tx, { type: 'dsar.opened', actor: { kind: 'customer', ref: `contact:${d.contactId}` }, subject: `dsar:${r.id}`, payload: { kind: d.kind, identity: d.identity, due: dueAt.toISOString().slice(0, 10) } });
  return { id: r.id, dueAt, created: true };
}

/** The fields a copy may contain: each must be declared in the erasure registry with dsar: true (F20). */
const EXPORT_FIELDS = {
  contacts: ['display_name_enc', 'email_enc', 'phone_enc'],
  messages: ['subject_enc', 'body_enc'],
  outbox: ['body_enc'],
} as const;

export function exportFieldsAreDeclared(): string[] {
  const problems: string[] = [];
  for (const [table, cols] of Object.entries(EXPORT_FIELDS)) {
    for (const c of cols) if (!ERASURE_REGISTRY[table]?.columns[c]?.dsar) problems.push(`${table}.${c} is exported but not declared dsar: true`);
  }
  return problems;
}

export interface SubjectCopy {
  readonly generated_at: string;
  readonly business: string;
  readonly about_you: { readonly name: string | null; readonly email: string | null; readonly phone: string | null; readonly first_contact: string; readonly how_we_got_it: string };
  readonly messages_from_you: readonly { readonly at: string; readonly channel: string; readonly subject: string | null; readonly text: string }[];
  readonly messages_to_you: readonly { readonly at: string; readonly channel: string; readonly text: string }[];
  readonly consents: readonly { readonly at: string; readonly purpose: string; readonly channel: string; readonly action: string; readonly source: string }[];
  readonly why_and_how_long: string;
}

export async function assembleCopy(deps: { keyring: TenantKeyring; clock: Clock }, tx: TenantTx, contactId: string, business: string, privacyUrl: string): Promise<SubjectCopy> {
  const problems = exportFieldsAreDeclared();
  if (problems.length) throw new Error(`F20: ${problems.join('; ')}`);
  const open = async (table: string, column: string, rowId: string, enc: Buffer | null) => (enc ? deps.keyring.openText(tx, { table, column, rowId }, enc) : null);
  const c = await tx.selectFrom('contacts').select(['id', 'display_name_enc', 'email_enc', 'phone_enc', 'captured_at', 'source']).where('id', '=', contactId).executeTakeFirstOrThrow();
  const inbound = await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id')
    .select(['messages.id', 'messages.channel', 'messages.received_at', 'messages.subject_enc', 'messages.body_enc'])
    .where('conversations.contact_id', '=', contactId).where('messages.direction', '=', 'inbound').orderBy('messages.received_at').execute();
  const outbound = await tx.selectFrom('outbox').select(['id', 'channel', 'sent_at', 'body_enc']).where('contact_id', '=', contactId).where('state', '=', 'sent').orderBy('sent_at').execute();
  const consents = await tx.selectFrom('consents').select(['recorded_at', 'purpose', 'channel', 'action', 'source']).where('contact_id', '=', contactId).orderBy('recorded_at').execute();
  return {
    generated_at: deps.clock.now().toISOString(), business,
    about_you: {
      name: await open('contacts', 'display_name_enc', c.id, c.display_name_enc), email: await open('contacts', 'email_enc', c.id, c.email_enc),
      phone: await open('contacts', 'phone_enc', c.id, c.phone_enc), first_contact: new Date(c.captured_at).toISOString(), how_we_got_it: c.source,
    },
    messages_from_you: await Promise.all(inbound.map(async (m) => ({ at: new Date(m.received_at).toISOString(), channel: m.channel, subject: await open('messages', 'subject_enc', m.id, m.subject_enc), text: (await open('messages', 'body_enc', m.id, m.body_enc)) ?? '' }))),
    messages_to_you: await Promise.all(outbound.map(async (o) => ({ at: o.sent_at?.toISOString() ?? '', channel: o.channel, text: (await open('outbox', 'body_enc', o.id, o.body_enc)) ?? '' }))),
    consents: consents.map((k) => ({ at: k.recorded_at.toISOString(), purpose: k.purpose, channel: k.channel, action: k.action, source: k.source })),
    why_and_how_long: `${business} uses this information to answer your enquiries and do the work you ask for. Full details, including how long it is kept and your rights: ${privacyUrl}`,
  };
}

export const DOWNLOAD_TTL_MS = 7 * 86_400_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Seals the copy with the person's own key and returns a one-time link token (shown once). */
export async function prepareDownload(deps: { keyring: TenantKeyring; clock: Clock }, tx: TenantTx, dsarId: string, contactId: string, copy: SubjectCopy): Promise<string> {
  const prefix = 'dl_' + randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 12);
  const token = `${prefix}.${randomBytes(32).toString('base64url')}`;
  await tx.updateTable('dsar_requests').set({
    export_enc: await deps.keyring.seal(tx, { table: 'dsar_requests', column: 'export_enc', rowId: dsarId, subject: contactId }, JSON.stringify(copy)),
    download_prefix: prefix, download_hash: sha256(token), download_expires_at: new Date(deps.clock.nowMs() + DOWNLOAD_TTL_MS),
  }).where('id', '=', dsarId).execute();
  return token;
}

export type DownloadResult = { readonly status: 'ok'; readonly body: string } | { readonly status: 'gone' | 'not_found' };

/** Serves a copy once, before expiry. Found by the link's prefix before the tenant is known (like API keys). */
export async function downloadCopy(db: Db, deps: { keyring: TenantKeyring; clock: Clock }, token: string, withTenant: <T>(db: Db, s: TenantScope, fn: (tx: TenantTx) => Promise<T>) => Promise<T>): Promise<DownloadResult> {
  const m = /^(dl_[a-z0-9]{12})\.([A-Za-z0-9_-]{30,100})$/.exec(token);
  const prefix = m?.[1];
  if (!prefix) return { status: 'not_found' };
  const row = await db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.dsar_download_prefix', ${prefix}, true)`.execute(trx);
    return trx.selectFrom('dsar_requests').select(['id', 'tenant_id', 'region', 'download_hash']).where('download_prefix', '=', prefix).executeTakeFirst();
  });
  if (!row?.download_hash || !timingSafeEqual(row.download_hash, sha256(token))) return { status: 'not_found' };
  const scope = { tenantId: tenantId(row.tenant_id), region: regionCode(row.region) };
  return withTenant(db, scope, async (tx) => {
    const d = await tx.selectFrom('dsar_requests').select(['id', 'export_enc', 'download_expires_at', 'downloaded_at']).where('id', '=', row.id).forUpdate().executeTakeFirstOrThrow();
    if (!d.export_enc || d.downloaded_at || !d.download_expires_at || d.download_expires_at.getTime() <= deps.clock.nowMs()) return { status: 'gone' as const };
    let body: string;
    try {
      body = await deps.keyring.openText(tx, { table: 'dsar_requests', column: 'export_enc', rowId: d.id }, d.export_enc);
    } catch {
      return { status: 'gone' as const };
    }
    await tx.updateTable('dsar_requests').set({ downloaded_at: deps.clock.now() }).where('id', '=', d.id).execute();
    await appendAudit(tx, { type: 'dsar.downloaded', actor: { kind: 'customer' }, subject: `dsar:${d.id}`, payload: {} });
    return { status: 'ok' as const, body };
  });
}
