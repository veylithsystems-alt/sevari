/** Provisioning of channel endpoints and API keys. Secrets are returned once and stored sealed or hashed. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendAudit } from '@sevari/audit';
import type { ChannelId } from '@sevari/channels';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { findApiKey, type Db, type TenantTx } from '@sevari/db';
import type { TenantScope } from '@sevari/domain';

export interface NewEndpoint {
  readonly channel: ChannelId;
  /** Recorded by a human at set-up (§8.3: lawful-basis decisions are human). */
  readonly lawfulBasis: string;
  readonly purpose: string;
  readonly allowedOrigins?: readonly string[];
  /** Webform endpoints are public and unsigned; every other channel gets an HMAC secret. */
  readonly withSecret?: boolean;
}

export async function createEndpoint(tx: TenantTx, keyring: TenantKeyring, spec: NewEndpoint, actorRef: string):
  Promise<{ id: string; publicId: string; secret: Buffer | null }> {
  const publicId = randomBytes(24).toString('base64url');
  const withSecret = spec.withSecret ?? spec.channel !== 'webform';
  const secret = withSecret ? randomBytes(32) : null;
  const row = await tx.insertInto('channel_endpoints').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, channel: spec.channel, public_id: publicId,
    lawful_basis: spec.lawfulBasis, purpose: spec.purpose, allowed_origins: [...(spec.allowedOrigins ?? [])],
  }).returning('id').executeTakeFirstOrThrow();
  if (secret) {
    const sealed = await keyring.seal(tx, { table: 'channel_endpoints', column: 'secret_enc', rowId: row.id }, secret);
    await tx.updateTable('channel_endpoints').set({ secret_enc: sealed }).where('id', '=', row.id).execute();
  }
  await appendAudit(tx, { type: 'endpoint.created', actor: { kind: 'user', ref: actorRef }, subject: `endpoint:${row.id}`, payload: { channel: spec.channel, signed: withSecret } });
  return { id: row.id, publicId, secret };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Returns the full key once: `sk_<12 chars>.<secret>`. Only its SHA-256 is stored (high-entropy secret). */
export async function createApiKey(tx: TenantTx, scopes: readonly string[], actorRef: string, expiresAt?: Date): Promise<string> {
  const prefix = 'sk_' + randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 12);
  const secret = randomBytes(32).toString('base64url');
  const full = `${prefix}.${secret}`;
  const row = await tx.insertInto('api_keys').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, prefix, key_hash: sha256(full), scopes: [...scopes], expires_at: expiresAt ?? null,
  }).returning('id').executeTakeFirstOrThrow();
  await appendAudit(tx, { type: 'api_key.created', actor: { kind: 'user', ref: actorRef }, subject: `api_key:${row.id}`, payload: { scopes: scopes.join(',') } });
  return full;
}

export async function verifyApiKey(db: Db, clock: Clock, presented: string, requiredScope: string): Promise<TenantScope | null> {
  const m = /^(sk_[a-z0-9]{12})\.([A-Za-z0-9_-]{20,100})$/.exec(presented);
  const prefix = m?.[1];
  if (!prefix) return null;
  const route = await findApiKey(db, prefix);
  if (!route) return null;
  const ok = timingSafeEqual(route.keyHash, sha256(presented));
  if (!ok) return null;
  if (route.expiresAt && route.expiresAt.getTime() <= clock.nowMs()) return null;
  if (!route.scopes.includes(requiredScope)) return null;
  return { tenantId: route.tenantId, region: route.region };
}
