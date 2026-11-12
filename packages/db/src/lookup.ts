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

export interface UserTokenRoute {
  readonly tenantId: TenantId;
  readonly region: RegionCode;
  readonly userId: string;
  readonly tokenHash: Buffer;
  readonly expiresAt: Date;
}

export async function findUserToken(db: Db, prefix: string): Promise<UserTokenRoute | null> {
  if (!/^ut_[a-z0-9]{12}$/.test(prefix)) return null;
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.user_token_prefix', ${prefix}, true)`.execute(trx);
    const r = await trx.selectFrom('user_tokens').select(['tenant_id', 'region', 'user_id', 'token_hash', 'expires_at']).where('prefix', '=', prefix).where('status', '=', 'active').executeTakeFirst();
    return r ? { tenantId: tenantId(r.tenant_id), region: regionCode(r.region), userId: r.user_id, tokenHash: r.token_hash, expiresAt: r.expires_at } : null;
  });
}

export async function findOperator(db: Db, prefix: string): Promise<{ id: string; tokenHash: Buffer; role: 'founder' | 'operator' | 'counsel' } | null> {
  if (!/^op_[a-z0-9]{12}$/.test(prefix)) return null;
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.operator_prefix', ${prefix}, true)`.execute(trx);
    const r = await trx.selectFrom('operators').select(['id', 'token_hash', 'role']).where('prefix', '=', prefix).where('status', '=', 'active').executeTakeFirst();
    return r ? { id: r.id, tokenHash: r.token_hash, role: r.role } : null;
  });
}

export interface PortalRoute { readonly id: string; readonly tenantId: TenantId; readonly region: RegionCode; readonly contactId: string; readonly tokenHash: Buffer; readonly expiresAt: Date }

/** A customer's portal link, found by its prefix before the business is known (§22). */
export async function findPortalToken(db: Db, prefix: string): Promise<PortalRoute | null> {
  if (!/^pl_[a-z0-9]{12}$/.test(prefix)) return null;
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.portal_prefix', ${prefix}, true)`.execute(trx);
    const r = await trx.selectFrom('portal_tokens').select(['id', 'tenant_id', 'region', 'contact_id', 'token_hash', 'expires_at']).where('prefix', '=', prefix).executeTakeFirst();
    return r ? { id: r.id, tenantId: tenantId(r.tenant_id), region: regionCode(r.region), contactId: r.contact_id, tokenHash: r.token_hash, expiresAt: r.expires_at } : null;
  });
}

/** Veylith's own account (the house tenant) in a region, for jobs that cross into it by design (final billing, §21.1). */
export async function findHouseTenant(db: Db, region: string): Promise<{ tenantId: TenantId; region: RegionCode } | null> {
  if (!/^[a-z][a-z0-9]{1,7}$/.test(region)) return null;
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.house_region', ${region}, true)`.execute(trx);
    const r = await trx.selectFrom('tenants').select(['id', 'region']).where('is_house', '=', true).where('region', '=', region).executeTakeFirst();
    return r ? { tenantId: tenantId(r.id), region: regionCode(r.region) } : null;
  });
}

/** The email channel a receiving address belongs to (inbound email through Brevo), before the business is known. */
export async function findEndpointByAddress(db: Db, address: string): Promise<{ publicId: string } | null> {
  const a = address.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,62}@[a-z0-9][a-z0-9.-]{1,200}$/.test(a)) return null;
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.inbound_address', ${a}, true)`.execute(trx);
    const r = await trx.selectFrom('channel_endpoints').select(['public_id', 'channel', 'status']).where('inbound_address', '=', a).executeTakeFirst();
    return r && r.channel === 'email' && r.status === 'active' ? { publicId: r.public_id } : null;
  });
}
