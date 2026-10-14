/**
 * Pre-tenant lookups. An inbound request carries a capability (endpoint public id, API key prefix);
 * the matching row, and only that row, becomes visible through a narrow RLS policy keyed on a
 * transaction-local setting. No other tenant data is reachable without a tenant scope.
 */
import { sql } from 'kysely';
import { regionCode, tenantId, type RegionCode, type TenantId } from '@sevari/domain';
import type { Db } from './session.ts';

export interface EndpointRoute {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly region: RegionCode;
  readonly channel: 'webform' | 'email' | 'sms' | 'api' | 'telephony';
  readonly secretEnc: Buffer | null;
  readonly lawfulBasis: string;
  readonly purpose: string;
  readonly allowedOrigins: readonly string[];
}

export async function findEndpoint(db: Db, publicId: string): Promise<EndpointRoute | null> {
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(publicId)) return null;
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.endpoint_public_id', ${publicId}, true)`.execute(trx);
    const r = await trx.selectFrom('channel_endpoints')
      .select(['id', 'tenant_id', 'region', 'channel', 'secret_enc', 'lawful_basis', 'purpose', 'allowed_origins'])
      .where('public_id', '=', publicId).executeTakeFirst();
    if (!r) return null;
    return {
      id: r.id, tenantId: tenantId(r.tenant_id), region: regionCode(r.region), channel: r.channel,
      secretEnc: r.secret_enc, lawfulBasis: r.lawful_basis, purpose: r.purpose, allowedOrigins: r.allowed_origins,
    };
  });
}

export interface ApiKeyRoute {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly region: RegionCode;
  readonly keyHash: Buffer;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
}

export async function findApiKey(db: Db, prefix: string): Promise<ApiKeyRoute | null> {
  if (!/^sk_[a-z0-9]{12}$/.test(prefix)) return null;
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.api_key_prefix', ${prefix}, true)`.execute(trx);
    const r = await trx.selectFrom('api_keys').select(['id', 'tenant_id', 'region', 'key_hash', 'scopes', 'expires_at'])
      .where('prefix', '=', prefix).executeTakeFirst();
    if (!r) return null;
    return { id: r.id, tenantId: tenantId(r.tenant_id), region: regionCode(r.region), keyHash: r.key_hash, scopes: r.scopes, expiresAt: r.expires_at };
  });
}
