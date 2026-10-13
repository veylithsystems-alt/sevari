import { z } from 'zod';

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Brand<string, 'TenantId'>;
export type RegionCode = Brand<string, 'RegionCode'>;
export type UserId = Brand<string, 'UserId'>;

const UUID = z.string().uuid();
/** Region codes are data (a row in `regions`), not an enum, so region #2 is config, not code (§1). */
const REGION = z.string().regex(/^[a-z][a-z0-9]{1,7}$/, 'region code must be 2-8 lowercase alphanumerics');

export const TenantIdSchema = UUID.transform((v) => v as TenantId);
export const RegionCodeSchema = REGION.transform((v) => v as RegionCode);
export const UserIdSchema = UUID.transform((v) => v as UserId);

export const tenantId = (v: string): TenantId => TenantIdSchema.parse(v);
export const regionCode = (v: string): RegionCode => RegionCodeSchema.parse(v);
export const userId = (v: string): UserId => UserIdSchema.parse(v);

/** Everything tenant-scoped runs inside one of these. There is no API that takes a tenant id alone. */
export interface TenantScope {
  readonly tenantId: TenantId;
  readonly region: RegionCode;
}
