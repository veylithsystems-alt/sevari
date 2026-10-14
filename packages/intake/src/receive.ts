/**
 * Inbound pipeline, first segment (contract §5.2):
 *   receive → authenticate channel → persist raw (encrypted) → [ACK, Phase 4] → enqueue next step.
 * Everything below happens in ONE tenant transaction, so a crash leaves either nothing or a complete,
 * queued message. Replays of the same provider message produce one message, one contact, one job.
 */
import { randomUUID } from 'node:crypto';
import { appendAudit } from '@sevari/audit';
import { InboundParseError, type ChannelAdapter, type ChannelId, type InboundItem, type RawInbound } from '@sevari/channels';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { enqueue, findEndpoint, withTenant, type Db, type TenantTx } from '@sevari/db';
import { normaliseEmail, normalisePhone, type RegionCode } from '@sevari/domain';
import { routeForTenant } from '@sevari/region';

export interface IntakeDeps {
  readonly db: Db;
  readonly keyring: TenantKeyring;
  readonly clock: Clock;
  readonly cellRegion: RegionCode;
  readonly cellUrls: Readonly<Record<string, string>>;
  readonly adapters: Readonly<Partial<Record<ChannelId, ChannelAdapter>>>;
}

export type IntakeResult =
  | { readonly status: 'accepted'; readonly messageId: string; readonly duplicate: boolean }
  | { readonly status: 'dropped'; readonly reason: string }
  | { readonly status: 'redirect'; readonly location: string }
  | { readonly status: 'rejected'; readonly httpStatus: 400 | 401 | 403 | 404 | 413; readonly reason: string };

/** The next workflow step for every new inbound message (Phase 3 picks it up). */
export const INBOUND_JOB = 'inbound.process';

export async function receiveInbound(deps: IntakeDeps, req: { channel: ChannelId; publicId: string; raw: RawInbound }): Promise<IntakeResult> {
  const adapter = deps.adapters[req.channel];
  // Unknown endpoint and wrong channel look identical to the caller: no endpoint enumeration.
  const notFound: IntakeResult = { status: 'rejected', httpStatus: 404, reason: 'unknown endpoint' };
  if (!adapter) return notFound;
  if (req.raw.body.length > adapter.capabilities.maxBodyBytes) return { status: 'rejected', httpStatus: 413, reason: 'body too large' };
  const endpoint = await findEndpoint(deps.db, req.publicId);
  if (!endpoint || endpoint.channel !== req.channel) return notFound;

  // §5.1: a request for a tenant homed in another cell is redirected, never proxied with its data.
  const route = routeForTenant({ region: deps.cellRegion }, endpoint.region, deps.cellUrls);
  if (route.kind === 'redirect') return { status: 'redirect', location: route.location };

  const scope = { tenantId: endpoint.tenantId, region: endpoint.region };
  return withTenant(deps.db, scope, async (tx) => {
    const secret = endpoint.secretEnc
      ? await deps.keyring.open(tx, { table: 'channel_endpoints', column: 'secret_enc', rowId: endpoint.id }, endpoint.secretEnc)
      : null;
    const verdict = adapter.verify(req.raw, { secret, allowedOrigins: endpoint.allowedOrigins, nowMs: deps.clock.nowMs() });
    if (!verdict.ok) {
      await appendAudit(tx, { type: 'inbound.rejected', actor: { kind: 'provider', ref: `endpoint:${endpoint.id}` }, payload: { channel: req.channel, reason: verdict.reason } });
      return { status: 'rejected', httpStatus: verdict.status, reason: verdict.reason };
    }
    if (verdict.drop) {
      await appendAudit(tx, { type: 'inbound.dropped', actor: { kind: 'provider', ref: `endpoint:${endpoint.id}` }, payload: { channel: req.channel, reason: verdict.drop } });
      return { status: 'dropped', reason: verdict.drop };
    }
    let item: InboundItem;
    try {
      item = adapter.parse(req.raw);
    } catch (err) {
      if (err instanceof InboundParseError) return { status: 'rejected', httpStatus: 400, reason: err.message };
      throw err;
    }
    return persist(deps, tx, endpoint.id, endpoint.lawfulBasis, req.channel, item, req.raw);
  });
}

async function persist(deps: IntakeDeps, tx: TenantTx, endpointId: string, lawfulBasis: string, channel: ChannelId, item: InboundItem, raw: RawInbound): Promise<IntakeResult> {
  const existing = await tx.selectFrom('messages').select('id')
    .where('channel', '=', channel).where('direction', '=', 'inbound').where('provider_message_id', '=', item.providerMessageId)
    .executeTakeFirst();
  if (existing) {
    await appendAudit(tx, { type: 'message.duplicate', actor: { kind: 'provider', ref: `endpoint:${endpointId}` }, subject: `message:${existing.id}`, payload: { channel } });
    return { status: 'accepted', messageId: existing.id, duplicate: true };
  }

  const email = item.from.email ? normaliseEmail(item.from.email) : null;
  const phone = item.from.phone ? normalisePhone(item.from.phone) : null;
  if (item.from.phone && !phone && !email) return { status: 'rejected', httpStatus: 400, reason: 'unrecognised phone number' };

  const contactId = await identifyContact(deps, tx, { email, phone, name: item.from.name ?? null, channel, lawfulBasis, endpointId });
  const conversationId = await openConversation(tx, contactId);

  const messageId = randomUUID();
  const field = (column: string) => ({ table: 'messages', column, rowId: messageId });
  const inserted = await tx.insertInto('messages').values({
    id: messageId, tenant_id: tx.scope.tenantId, region: tx.scope.region, conversation_id: conversationId,
    direction: 'inbound', channel, kind: item.kind, provider_message_id: item.providerMessageId, endpoint_id: endpointId,
    body_enc: await deps.keyring.seal(tx, field('body_enc'), item.text),
    subject_enc: item.subject ? await deps.keyring.seal(tx, field('subject_enc'), item.subject) : null,
    raw_enc: await deps.keyring.seal(tx, field('raw_enc'), raw.body),
    body_digest: await deps.keyring.index(tx, 'message_body', item.text),
    received_at: deps.clock.now(),
  }).onConflict((oc) => oc.columns(['tenant_id', 'channel', 'direction', 'provider_message_id']).doNothing())
    .returning('id').executeTakeFirst();
  if (!inserted) {
    // Lost a race with a concurrent replay of the same provider message: the other copy wins.
    const winner = await tx.selectFrom('messages').select('id').where('channel', '=', channel).where('direction', '=', 'inbound')
      .where('provider_message_id', '=', item.providerMessageId).executeTakeFirstOrThrow();
    return { status: 'accepted', messageId: winner.id, duplicate: true };
  }

  await enqueue(tx, { kind: INBOUND_JOB, dedupeKey: messageId, payload: { message_id: messageId } });
  await appendAudit(tx, {
    type: 'message.received', actor: { kind: 'customer', ref: `contact:${contactId}` }, subject: `message:${messageId}`,
    payload: { channel, kind: item.kind, endpoint_ref: `endpoint:${endpointId}`, conversation_ref: `conversation:${conversationId}` },
  });
  return { status: 'accepted', messageId, duplicate: false };
}

async function identifyContact(
  deps: IntakeDeps, tx: TenantTx,
  who: { email: string | null; phone: string | null; name: string | null; channel: ChannelId; lawfulBasis: string; endpointId: string },
): Promise<string> {
  const emailIdx = who.email ? await deps.keyring.index(tx, 'email', who.email) : null;
  const phoneIdx = who.phone ? await deps.keyring.index(tx, 'phone', who.phone) : null;
  const find = async () => {
    if (emailIdx) {
      const c = await tx.selectFrom('contacts').select('id').where('email_bidx', '=', emailIdx).executeTakeFirst();
      if (c) return c.id;
    }
    if (phoneIdx) {
      const c = await tx.selectFrom('contacts').select('id').where('phone_bidx', '=', phoneIdx).executeTakeFirst();
      if (c) return c.id;
    }
    return null;
  };
  const found = await find();
  if (found) return found;

  const id = randomUUID();
  const field = (column: string) => ({ table: 'contacts', column, rowId: id });
  // Provenance on every contact (§17.2, F10): where, on what basis, when and by what.
  const conflictTarget = emailIdx ? (['tenant_id', 'email_bidx'] as const) : (['tenant_id', 'phone_bidx'] as const);
  const created = await tx.insertInto('contacts').values({
    id, tenant_id: tx.scope.tenantId, region: tx.scope.region,
    display_name_enc: who.name ? await deps.keyring.seal(tx, field('display_name_enc'), who.name) : null,
    email_enc: who.email ? await deps.keyring.seal(tx, field('email_enc'), who.email) : null, email_bidx: emailIdx,
    phone_enc: who.phone ? await deps.keyring.seal(tx, field('phone_enc'), who.phone) : null, phone_bidx: phoneIdx,
    source: `channel:${who.channel}`, lawful_basis: who.lawfulBasis, captured_at: deps.clock.now(), captured_by: `endpoint:${who.endpointId}`,
  }).onConflict((oc) => oc.columns([...conflictTarget]).where(conflictTarget[1], 'is not', null).doNothing())
    .returning('id').executeTakeFirst();
  if (created) return created.id;
  const raced = await find();
  if (!raced) throw new Error('contact vanished after conflict');
  return raced;
}

async function openConversation(tx: TenantTx, contactId: string): Promise<string> {
  const open = await tx.selectFrom('conversations').select('id').where('contact_id', '=', contactId)
    .where('status', '<>', 'closed').orderBy('created_at', 'desc').limit(1).executeTakeFirst();
  if (open) return open.id;
  const c = await tx.insertInto('conversations').values({ tenant_id: tx.scope.tenantId, region: tx.scope.region, contact_id: contactId })
    .returning('id').executeTakeFirstOrThrow();
  return c.id;
}
